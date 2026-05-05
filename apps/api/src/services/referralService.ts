// referralService.ts — programa de indicação
// FEAT-REFERRAL-SETTINGS: lê recompensa, mínimo de compra, teto por usuário e
//   mensagem de recompensa das AdminSettings em vez de valores hardcoded.
// FIX-REFERRER-UPSERT: registerReferral agora usa upsert para criar o TelegramUser
//   do indicador caso ele ainda não exista no banco (ex: nunca comprou, só compartilhou
//   o link). Sem isso, referrerId ficava null e o referralCount travava em 0.
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getSetting } from '../routes/admin/settings';
import type { Prisma } from '@prisma/client';

type TransactionClient = Prisma.TransactionClient;

type RewardCallback = (
  userId: string,
  amount: number,
  description: string,
  tx: TransactionClient
) => Promise<void>;

export async function registerReferral(
  referrerTelegramId: string,
  referredTelegramId: string
): Promise<{ registered: boolean; reason?: string }> {
  if (referrerTelegramId === referredTelegramId) {
    return { registered: false, reason: 'Auto-indicação não permitida.' };
  }

  // FIX-REFERRER-UPSERT: garante que o indicador existe no banco mesmo que nunca
  // tenha interagido com a API antes. Sem isso, findUnique retorna null e o
  // referralCount fica preso em 0 para sempre.
  const [referrer, referred] = await Promise.all([
    prisma.telegramUser.upsert({
      where:  { telegramId: referrerTelegramId },
      update: {},
      create: { telegramId: referrerTelegramId },
      select: { id: true },
    }),
    prisma.telegramUser.findUnique({
      where:  { telegramId: referredTelegramId },
      select: { id: true },
    }),
  ]);

  // O indicado precisa já existir (ele acabou de mandar a mensagem de início)
  if (!referred) return { registered: false, reason: 'Usuário indicado não encontrado.' };

  const existing = await prisma.referral.findUnique({ where: { referredId: referred.id } });
  if (existing) {
    return { registered: false, reason: 'Este usuário já foi indicado anteriormente.' };
  }

  await prisma.referral.create({
    data: { referrerId: referrer.id, referredId: referred.id },
  });

  logger.info(`[referral] Registrado: referrer=${referrerTelegramId} referred=${referredTelegramId}`);
  return { registered: true };
}

export async function payReferralReward(
  tx: TransactionClient,
  paymentId: string,
  onReward: RewardCallback
): Promise<void> {
  // ── Lê todas as configurações do programa ────────────────────────────────────
  const [enabledStr, minPurchaseStr, maxPerUserStr, rewardMsgTpl] = await Promise.all([
    getSetting('referral_enabled'),
    getSetting('referral_min_purchase'),
    getSetting('referral_max_per_user'),
    getSetting('referral_reward_message'),
  ]);

  if (enabledStr === 'false') return;

  // ── Busca o pagamento ─────────────────────────────────────────────────────────
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { telegramUserId: true, amount: true },
  });
  if (!payment) return;

  // ── Verifica valor mínimo de compra ───────────────────────────────────────────
  const minPurchase = parseFloat(minPurchaseStr) || 0;
  if (minPurchase > 0 && Number(payment.amount) < minPurchase) {
    logger.info(`[referral] Compra R$${payment.amount} abaixo do mínimo R$${minPurchase} — recompensa não paga`);
    return;
  }

  // ── Busca referral pendente ───────────────────────────────────────────────────
  const referral = await tx.referral.findUnique({
    where: { referredId: payment.telegramUserId },
    include: {
      referrer: { select: { telegramId: true } },
      referred: { select: { firstName: true } },
    },
  });
  if (!referral || referral.rewardPaid) return;

  // ── Verifica teto de recompensas por indicador ────────────────────────────────
  const maxPerUser = parseInt(maxPerUserStr, 10) || 0;
  if (maxPerUser > 0) {
    const paidCount = await tx.referral.count({
      where: { referrerId: referral.referrerId, rewardPaid: true },
    });
    if (paidCount >= maxPerUser) {
      logger.info(`[referral] Teto de ${maxPerUser} atingido para referrerId=${referral.referrerId}`);
      return;
    }
  }

  // ── Lê valor de recompensa configurado ────────────────────────────────────────
  const rewardRaw = await getSetting('referral_reward_amount');
  const rewardAmount = parseFloat(rewardRaw) || 5.0;
  if (isNaN(rewardAmount) || rewardAmount <= 0) return;

  // ── Monta mensagem com placeholders ──────────────────────────────────────────
  const referredName = referral.referred?.firstName ?? 'alguém';
  const description = rewardMsgTpl
    .replace('{amount}', rewardAmount.toFixed(2))
    .replace('{name}', referredName);

  // ── Delega crédito ao callback ────────────────────────────────────────────────
  await onReward(referral.referrer.telegramId, rewardAmount, description, tx);

  // ── Marca recompensa como paga ────────────────────────────────────────────────
  await tx.referral.update({
    where: { id: referral.id },
    data: { rewardPaid: true, rewardAmount, paymentId },
  });

  logger.info(`[referral] Recompensa R$${rewardAmount} paga ao referrerId=${referral.referrerId} paymentId=${paymentId}`);
}

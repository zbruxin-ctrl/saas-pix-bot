// referralService.ts — programa de indicação
// FIX-BOTH-UPSERT: upsert nos dois lados (referrer e referred) para que o
//   registro nunca falhe por "usuário não encontrado", independente de o
//   usuário já ter interagido com a API antes (ex: WhatsApp, Telegram, etc).
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

  // FIX-BOTH-UPSERT: ambos os usuários são garantidos no banco via upsert.
  // Antes, o "findUnique" do indicado retornava null quando ele ainda não
  // havia feito nenhuma compra/consulta, causando "Usuário indicado não encontrado."
  const [referrer, referred] = await Promise.all([
    prisma.telegramUser.upsert({
      where:  { telegramId: referrerTelegramId },
      update: {},
      create: { telegramId: referrerTelegramId },
      select: { id: true },
    }),
    prisma.telegramUser.upsert({
      where:  { telegramId: referredTelegramId },
      update: {},
      create: { telegramId: referredTelegramId },
      select: { id: true },
    }),
  ]);

  // Verifica se já existe um referral para o indicado
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
  const [enabledStr, minPurchaseStr, maxPerUserStr, rewardMsgTpl] = await Promise.all([
    getSetting('referral_enabled'),
    getSetting('referral_min_purchase'),
    getSetting('referral_max_per_user'),
    getSetting('referral_reward_message'),
  ]);

  if (enabledStr === 'false') return;

  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { telegramUserId: true, amount: true },
  });
  if (!payment) return;

  const minPurchase = parseFloat(minPurchaseStr) || 0;
  if (minPurchase > 0 && Number(payment.amount) < minPurchase) {
    logger.info(`[referral] Compra R$${payment.amount} abaixo do mínimo R$${minPurchase} — recompensa não paga`);
    return;
  }

  const referral = await tx.referral.findUnique({
    where: { referredId: payment.telegramUserId },
    include: {
      referrer: { select: { telegramId: true } },
      referred: { select: { firstName: true } },
    },
  });
  if (!referral || referral.rewardPaid) return;

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

  const rewardRaw = await getSetting('referral_reward_amount');
  const rewardAmount = parseFloat(rewardRaw) || 5.0;
  if (isNaN(rewardAmount) || rewardAmount <= 0) return;

  const referredName = referral.referred?.firstName ?? 'alguém';
  const description = rewardMsgTpl
    .replace('{amount}', rewardAmount.toFixed(2))
    .replace('{name}', referredName);

  await onReward(referral.referrer.telegramId, rewardAmount, description, tx);

  await tx.referral.update({
    where: { id: referral.id },
    data: { rewardPaid: true, rewardAmount, paymentId },
  });

  logger.info(`[referral] Recompensa R$${rewardAmount} paga ao referrerId=${referral.referrerId} paymentId=${paymentId}`);
}

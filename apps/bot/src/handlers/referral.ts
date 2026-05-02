// referral.ts — handler do programa de indicação (comando /indicar + callback show_referral)
import { Context, Markup } from 'telegraf';
import { editOrReply } from '../utils/helpers';
import { registerReferral, getReferralStats } from '../services/referralClient';

const BOT_USERNAME = process.env.BOT_USERNAME ?? '';

// ─── Menu inline de Indicação (callback show_referral) ──────────────────────

export async function showReferralMenu(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id);
  if (!telegramId || telegramId === 'undefined') return;

  const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;

  let totalIndicados = 0;
  let totalCompraram = 0;
  let totalGanho = 0;

  try {
    const stats = await getReferralStats(telegramId);
    totalIndicados = stats.totalReferred ?? 0;
    totalCompraram = stats.totalConverted ?? 0;
    totalGanho = stats.totalEarned ?? 0;
  } catch (err) {
    console.warn('[referral] Erro ao buscar stats:', err);
  }

  const statsBlock =
    `\n\n📊 <b>Suas estatísticas</b>\n` +
    `👥 Amigos indicados: <b>${totalIndicados}</b>\n` +
    `✅ Amigos que compraram: <b>${totalCompraram}</b>\n` +
    `💰 Total ganho em saldo: <b>R$ ${totalGanho.toFixed(2)}</b>`;

  const text =
    `🎁 <b>Indique e Ganhe</b>\n\n` +
    `Compartilhe seu link e ganhe saldo toda vez que um amigo fizer o <b>primeiro pedido</b>!\n\n` +
    `🔗 <b>Seu link de indicação:</b>\n` +
    `<code>${refLink}</code>` +
    statsBlock +
    `\n\n<i>O crédito cai automaticamente no seu saldo após o pagamento do indicado ser aprovado. 🚀</i>`;

  await editOrReply(ctx, text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.url('📤 Compartilhar link', `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Use meu link e ganhe desconto!')}`)],
      [Markup.button.callback('◀️ Voltar ao Menu', 'show_home')],
    ]).reply_markup,
  });
}

// ─── Comando /indicar (mensagem nova, sem edição) ────────────────────────────

export async function handleReferral(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id);
  if (!telegramId || telegramId === 'undefined') return;

  const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;

  let totalIndicados = 0;
  let totalCompraram = 0;
  let totalGanho = 0;

  try {
    const stats = await getReferralStats(telegramId);
    totalIndicados = stats.totalReferred ?? 0;
    totalCompraram = stats.totalConverted ?? 0;
    totalGanho = stats.totalEarned ?? 0;
  } catch (err) {
    console.warn('[referral] Erro ao buscar stats:', err);
  }

  const statsBlock =
    `\n\n📊 <b>Suas estatísticas</b>\n` +
    `👥 Amigos indicados: <b>${totalIndicados}</b>\n` +
    `✅ Amigos que compraram: <b>${totalCompraram}</b>\n` +
    `💰 Total ganho em saldo: <b>R$ ${totalGanho.toFixed(2)}</b>`;

  await ctx.reply(
    `🎁 <b>Indique e Ganhe</b>\n\n` +
    `Compartilhe seu link e ganhe saldo toda vez que um amigo fizer o <b>primeiro pedido</b>!\n\n` +
    `🔗 <b>Seu link de indicação:</b>\n` +
    `<code>${refLink}</code>` +
    statsBlock +
    `\n\n<i>O crédito cai automaticamente no seu saldo após o pagamento do indicado ser aprovado. 🚀</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('📤 Compartilhar', `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Use meu link e ganhe desconto!')}`)],
      ]).reply_markup,
    }
  );
}

// ─── Processa deep link ref_XXX no /start ───────────────────────────────────

export async function processReferralStart(
  ctx: Context,
  startPayload: string
): Promise<void> {
  if (!startPayload.startsWith('ref_')) return;

  const referrerTelegramId = startPayload.replace('ref_', '');
  const referredTelegramId = String(ctx.from?.id);

  if (
    !referredTelegramId ||
    referredTelegramId === 'undefined' ||
    referrerTelegramId === referredTelegramId
  ) return;

  const result = await registerReferral(referrerTelegramId, referredTelegramId);
  if (result.success) {
    console.info(`[referral] Novo indicado ${referredTelegramId} via ${referrerTelegramId}`);
  }
}

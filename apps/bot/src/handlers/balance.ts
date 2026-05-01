/**
 * Handlers de saldo: visualização, depósito via PIX.
 */
import { Context, Markup } from 'telegraf';
import { escapeMd } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession, saveSession } from '../services/session';
import { apiClient } from '../services/apiClient';
import { showBlockedMessage } from './navigation';
import type { WalletTransactionDTO } from '@saas-pix/shared';

export async function showBalance(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const { balance, transactions } = await apiClient.getBalance(String(userId));

    const txLines = (transactions as WalletTransactionDTO[])
      .slice(0, 5)
      .map((t) => {
        const sinal = t.type === 'DEPOSIT' ? '➕' : '➖';
        return `${sinal} R$ ${Number(t.amount).toFixed(2)} — ${escapeMd(t.description)}`;
      })
      .join('\n');

    const texto =
      `💰 *Seu Saldo*\n\n` +
      `Disponível: *R$ ${escapeMd(Number(balance).toFixed(2))}*\n\n` +
      (txLines ? `*Últimas transações:*\n${txLines}\n\n` : '_Nenhuma transação ainda\._ \n\n') +
      `Use seu saldo para comprar sem precisar fazer PIX toda hora\!`;

    const config = await apiClient.getBotConfig(String(userId)).catch(() => ({ isBlocked: false }));
    const buttons = config.isBlocked
      ? [
          [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ]
      : [
          [Markup.button.callback('➕ Adicionar Saldo', 'deposit_balance')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ];

    await editOrReply(ctx, texto, {
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (err) {
    console.error(`[showBalance] Erro para ${userId}:`, err);
    await editOrReply(ctx, '❌ Erro ao buscar saldo\. Tente novamente\.', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
    });
  }
}

export async function handleDepositAmount(ctx: Context, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);

  const valor = parseFloat(text.replace(',', '.'));

  if (isNaN(valor) || valor < 1 || valor > 10000) {
    await ctx.reply(
      '❌ Valor inválido\. Digite um valor entre R\$ 1,00 e R\$ 10\.000,00\.\n\nExemplo: `25` ou `50.00`',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  session.step = 'idle';
  await saveSession(userId, session);

  const processingMsg = await ctx.reply('⏳ Gerando PIX de depósito, aguarde\.\.\.', { parse_mode: 'MarkdownV2' });

  try {
    const deposit = await apiClient.createDeposit(String(userId), valor, ctx.from?.first_name, ctx.from?.username);
    session.depositPaymentId = deposit.paymentId;

    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});

    const expiresAt = new Date(deposit.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const qrBuffer = Buffer.from(deposit.pixQrCode, 'base64');
    const depositMsg = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption:
          `💳 *Depósito de Saldo*\n` +
          `Valor: *R$ ${escapeMd(valor.toFixed(2))}*\n` +
          `Válido até: ${escapeMd(expiresStr)}\n` +
          `🪪 ID: \`${escapeMd(deposit.paymentId)}\`\n\n` +
          `📋 *Copia e Cola:*\n\`${escapeMd(deposit.pixQrCodeText)}\`\n\n` +
          `Após o pagamento, o saldo será creditado automaticamente\! ✅`,
        parse_mode: 'MarkdownV2',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${deposit.paymentId}`)],
          [Markup.button.callback('❌ Cancelar Depósito', `cancel_payment_${deposit.paymentId}`)],
        ]).reply_markup,
      }
    );

    session.depositMessageId = depositMsg.message_id;
    session.mainMessageId = depositMsg.message_id;
    await saveSession(userId, session);

    console.info(`[deposit] PIX gerado para ${userId} | valor: ${valor} | id: ${deposit.paymentId}`);
  } catch (err) {
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    console.error(`[deposit] Erro para ${userId}:`, err);

    const errMsg = err instanceof Error ? err.message : '';
    const errStatus = (err as { statusCode?: number }).statusCode ?? 0;

    if (errStatus === 403 || errMsg.toLowerCase().includes('suspensa')) {
      await showBlockedMessage(ctx);
      return;
    }

    await ctx.reply(
      '❌ Erro ao gerar PIX de depósito\. Tente novamente\.',
      {
        parse_mode: 'MarkdownV2',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_balance')]]).reply_markup,
      }
    );
  }
}

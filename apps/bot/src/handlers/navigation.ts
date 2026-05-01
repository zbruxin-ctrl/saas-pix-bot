/**
 * Handlers de navegação: home, produtos, ajuda, pedidos.
 */
import { Context, Markup } from 'telegraf';
import { escapeMd, escapeHtml } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession, saveSession } from '../services/session';
import { apiClient } from '../services/apiClient';
import { env } from '../config/env';
import type { OrderSummary } from '../services/apiClient';

export async function showHome(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  const firstName = escapeMd(session.firstName || ctx.from?.first_name || 'visitante');

  await editOrReply(
    ctx,
    `👋 Olá, *${firstName}*\! Bem\-vindo\!\n\n` +
      `🛒 Aqui você pode adquirir nossos produtos de forma rápida e segura\.\n\n` +
      `💳 Aceitamos pagamento via *PIX* \(confirmação instantânea\) ou via *saldo* pré\-carregado\.\n\n` +
      `Para ver nossos produtos, clique no botão abaixo:`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
        [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
        [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('❓ Ajuda', 'show_help')],
      ]).reply_markup,
    }
  );
}

export async function showProducts(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  session.step = 'idle';
  await saveSession(userId, session);

  try {
    const products = await apiClient.getProducts();
    session.products = products as never;

    if (products.length === 0) {
      await editOrReply(ctx, '😔 Nenhum produto disponível no momento\. Volte em breve\!', {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
      });
      return;
    }

    const buttons = products.map((p) => {
      const stockLabel = p.stock != null ? ` \(${p.stock} restantes\)` : '';
      const label = `${p.name}${stockLabel} — R$ ${Number(p.price).toFixed(2)}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });
    buttons.push([Markup.button.callback('◀️ Voltar', 'show_home')]);

    await editOrReply(ctx, `🛒 *Nossos Produtos*\n\nEscolha um produto abaixo:`, {
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (error) {
    console.error('[showProducts] Erro:', error);
    await editOrReply(ctx, '❌ Erro ao buscar produtos\. Tente novamente em instantes\.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_products')],
        [Markup.button.callback('◀️ Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

export async function showOrders(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    // Paginação: busca apenas os 10 mais recentes
    const orders = await apiClient.getOrders(String(userId), 10);

    if (!orders || orders.length === 0) {
      await editOrReply(
        ctx,
        `📦 *Meus Pedidos*\n\n_Você ainda não fez nenhum pedido\._ \n\nCompre um produto e ele aparecerá aqui\!`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
            [Markup.button.callback('◀️ Voltar', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    const statusEmoji: Record<string, string> = {
      DELIVERED: '✅',
      PENDING: '⏳',
      FAILED: '❌',
      PROCESSING: '🔄',
    };

    const lines = orders.map((o: OrderSummary) => {
      const emoji = statusEmoji[o.status] ?? '📦';
      const date = new Date(o.createdAt).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      const valor = o.amount != null ? ` · R$ ${Number(o.amount).toFixed(2)}` : '';
      const metodo =
        o.paymentMethod === 'BALANCE'
          ? ' · 💰Saldo'
          : o.paymentMethod === 'MIXED'
            ? ' · 🔀Misto'
            : o.paymentMethod === 'PIX'
              ? ' · 📱PIX'
              : '';
      return `${emoji} *${escapeMd(o.productName)}* \— ${escapeMd(date)}${escapeMd(valor)}${escapeMd(metodo)}`;
    });

    await editOrReply(
      ctx,
      `📦 *Meus Pedidos*\n\n${lines.join('\n')}\n\n_Para suporte, entre em contato informando o nome do produto e a data\._`,
      {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
      }
    );
  } catch (err) {
    console.error(`[showOrders] Erro para ${userId}:`, err);
    await editOrReply(ctx, '❌ Erro ao buscar seus pedidos\. Tente novamente\.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_orders')],
        [Markup.button.callback('◀️ Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

export async function showHelp(ctx: Context): Promise<void> {
  const supportUrl = `https://wa.me/${encodeURIComponent(env.SUPPORT_PHONE)}`;

  // showHelp usa HTML porque tem muito conteúdo estruturado com tags
  const chatId = ctx.chat?.id;
  const userId = ctx.from!.id;
  const session = await getSession(userId);

  const text =
    `❓ <b>Central de Ajuda</b>\n\n` +
    `<b>Comandos disponíveis:</b>\n` +
    `/start — Tela inicial\n` +
    `/produtos — Ver produtos\n` +
    `/saldo — Ver e adicionar saldo\n` +
    `/meus_pedidos — Histórico de pedidos\n` +
    `/ajuda — Esta mensagem\n\n` +
    `<b>Como funciona?</b>\n` +
    `1. Escolha um produto\n` +
    `2. Escolha como pagar: saldo, PIX ou os dois\n` +
    `3. Receba seu acesso automaticamente ✅\n\n` +
    `<b>Saldo pré-pago:</b>\n` +
    `Faça um depósito uma vez e use para várias compras\.\n\n` +
    `<b>Problemas com pagamento?</b>\n` +
    `Entre em contato informando o ID do pagamento\.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('📞 Contatar Suporte', supportUrl)],
    [Markup.button.callback('◀️ Voltar', 'show_home')],
  ]);

  if (session.mainMessageId && chatId) {
    try {
      await ctx.telegram.editMessageText(chatId, session.mainMessageId, undefined, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
      });
      return;
    } catch {
      // fallthrough
    }
  }

  const sent = await ctx.telegram.sendMessage(chatId ?? userId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard.reply_markup,
  });
  session.mainMessageId = sent.message_id;
  await saveSession(userId, session);
}

export async function showBlockedMessage(ctx: Context): Promise<void> {
  const supportUrl = `https://wa.me/${encodeURIComponent(env.SUPPORT_PHONE)}`;
  await editOrReply(
    ctx,
    `🚨 *Conta Suspensa*\n\n` +
      `Sua conta foi *suspensa* e o acesso a compras e depósitos está restrito\.\n\n` +
      `Você ainda pode:\n` +
      `✅ Ver seu saldo\n` +
      `✅ Consultar seus pedidos\n` +
      `✅ Acessar a ajuda\n\n` +
      `Se acredita que isso é um erro, entre em contato com o suporte\.`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('📞 Falar com Suporte', supportUrl)],
        [Markup.button.callback('💰 Ver Saldo', 'show_balance')],
        [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('❓ Ajuda', 'show_help')],
      ]).reply_markup,
    }
  );
}

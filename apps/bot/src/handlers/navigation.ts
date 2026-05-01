/**
 * Handlers de navegação: home, produtos, pedidos, ajuda e mensagem de conta bloqueada.
 * PADRÃO: parse_mode HTML em todas as mensagens.
 */
import { Context, Markup } from 'telegraf';
import { escapeHtml } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession } from '../services/session';
import { apiClient } from '../services/apiClient';

// ─── Home ────────────────────────────────────────────────────────────────────

export async function showHome(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  const firstName = escapeHtml(ctx.from?.first_name || session.firstName || 'visitante');

  const text = `👋 <b>Olá, ${firstName}!</b>\n\nEscolha uma opção abaixo para continuar:`;

  await editOrReply(ctx, text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ]).reply_markup,
  });
}

// ─── Produtos ────────────────────────────────────────────────────────────────

export async function showProducts(ctx: Context): Promise<void> {
  try {
    const products = await apiClient.getProducts();

    if (!products || products.length === 0) {
      await editOrReply(ctx, '🔭 <b>Nenhum produto disponível no momento.</b>\n\nVolte em breve!', {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
      });
      return;
    }

    const buttons = products.map((p) => {
      const stock = p.stock != null && p.stock <= 0 ? ' [ESGOTADO]' : '';
      const label = `${p.name}${stock} — R$ ${Number(p.price).toFixed(2)}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });

    buttons.push([Markup.button.callback('◀️ Voltar', 'show_home')]);

    await editOrReply(ctx, '<b>🛒 Produtos Disponíveis</b>\n\nEscolha um produto:', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch {
    await editOrReply(ctx, '⚠️ Erro ao carregar produtos. Tente novamente!', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
    });
  }
}

// ─── Pedidos ─────────────────────────────────────────────────────────────────

export async function showOrders(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const orders = await apiClient.getOrders(String(userId));

    if (!orders || orders.length === 0) {
      await editOrReply(ctx, '🔭 <b>Você ainda não tem pedidos.</b>\n\nFaça sua primeira compra!', {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ]).reply_markup,
      });
      return;
    }

    const lines = orders.slice(0, 10).map((o, i) => {
      const status =
        o.status === 'DELIVERED' ? '✅'
        : o.status === 'PENDING' ? '⏳'
        : o.status === 'CANCELLED' ? '❌'
        : '❓';
      return `${i + 1}. ${status} <b>${escapeHtml(o.productName)}</b> — R$ ${Number(o.amount).toFixed(2)}`;
    });

    await editOrReply(
      ctx,
      `<b>📦 Seus Últimos Pedidos</b>\n\n${lines.join('\n')}\n\n<i>Exibindo até 10 pedidos mais recentes.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Nova Compra', 'show_products')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ]).reply_markup,
      }
    );
  } catch {
    await editOrReply(ctx, '⚠️ Erro ao carregar pedidos. Tente novamente!', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
    });
  }
}

// ─── Ajuda ───────────────────────────────────────────────────────────────────

export async function showHelp(ctx: Context): Promise<void> {
  await editOrReply(
    ctx,
    `<b>❓ Central de Ajuda</b>\n\n` +
      `<b>Como funciona?</b>\n` +
      `1. Escolha um produto em 🛒 <b>Ver Produtos</b>\n` +
      `2. Selecione a forma de pagamento (PIX ou Saldo)\n` +
      `3. Pague e receba seu produto automaticamente\n\n` +
      `<b>Problemas?</b>\n` +
      `• PIX não aprovado? Aguarde até 2 minutos e verifique novamente.\n` +
      `• Produto não entregue? Entre em contato com o suporte.`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
    }
  );
}

// ─── Conta bloqueada ─────────────────────────────────────────────────────────

export async function showBlockedMessage(ctx: Context): Promise<void> {
  await editOrReply(
    ctx,
    `🚫 <b>Conta Suspensa</b>\n\n` +
      `Sua conta foi suspensa temporariamente.\n` +
      `Entre em contato com o suporte para mais informações.`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❓ Ajuda', 'show_help')]]).reply_markup,
    }
  );
}

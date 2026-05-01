/**
 * Ponto de entrada do bot — inicialização, registro de handlers e servidor webhook.
 * Toda a lógica de negócio está nos módulos em handlers/ e services/.
 *
 * FIX #1: ao receber /start, re-agenda o timer de expiração do PIX para
 *         usuários com pagamento em aberto (resistência a restarts via Redis).
 */

// Sentry DEVE ser o primeiro import — captura erros desde o início
import { initSentry, captureError } from './config/sentry';
initSentry();

import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { env } from './config/env';
import { apiClient, invalidateProductCache, invalidateBotConfigCache } from './services/apiClient';
import { getSession, saveSession, clearSession } from './services/session';
import { markUpdateProcessed } from './services/locks';

// Handlers
import { globalMiddleware } from './handlers/middleware';
import { showHome, showProducts, showOrders, showHelp } from './handlers/navigation';
import { showBalance, handleDepositAmount } from './handlers/balance';
import {
  initPaymentHandlers,
  executePayment,
  handleCheckPayment,
  handleCancelPayment,
  showPaymentMethodScreen,
  schedulePIXExpiry,
} from './handlers/payments';

import type { ProductDTO } from '@saas-pix/shared';

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
initPaymentHandlers(bot);

// ─── Middleware global ────────────────────────────────────────────────────────
bot.use(globalMiddleware);

// ─── Comandos ─────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const userId = ctx.from!.id;
  const existing = await getSession(userId);

  if (existing.step === 'awaiting_payment' && existing.paymentId) {
    // FIX #1: re-agenda o timer de expiração usando o tempo restante do Redis
    if (existing.pixExpiresAt) {
      const remaining = new Date(existing.pixExpiresAt).getTime() - Date.now();
      if (remaining > 0) {
        const chatId = ctx.chat?.id ?? userId;
        schedulePIXExpiry(userId, existing.paymentId, chatId, remaining);
        console.info(
          `[/start] PIX re-agendado para userId ${userId} | paymentId: ${existing.paymentId} | restam: ${Math.round(remaining / 1000)}s`
        );
      }
    }

    await ctx.reply(
      '⚠️ Você tem um *pagamento PIX em andamento*\!\n\n' +
      'Use os botões acima para verificar ou cancelar\.\n' +
      'Ou aguarde expirar automaticamente em 30 minutos\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  await saveSession(userId, {
    step: 'idle',
    firstName: ctx.from?.first_name || existing.firstName,
    lastActivityAt: Date.now(),
  });
  await showHome(ctx);
});

bot.command('produtos', (ctx) => showProducts(ctx));
bot.command('saldo', (ctx) => showBalance(ctx));
bot.command('ajuda', (ctx) => showHelp(ctx));
bot.command('meus_pedidos', (ctx) => showOrders(ctx));

// ─── Actions de navegação ─────────────────────────────────────────────────────
bot.action('show_home', async (ctx) => {
  await ctx.answerCbQuery();
  await showHome(ctx);
});

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produtos...');
  await showProducts(ctx);
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelp(ctx);
});

bot.action('show_orders', async (ctx) => {
  await ctx.answerCbQuery('📦 Carregando pedidos...');
  await showOrders(ctx);
});

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('⏳ Buscando saldo...');
  await showBalance(ctx);
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from!.id);
  session.step = 'awaiting_deposit_amount';
  await saveSession(ctx.from!.id, session);
  await ctx.reply(
    '💳 *Adicionar Saldo*\n\n' +
      'Digite o valor em reais que deseja depositar:\n' +
      '_\(mínimo R\$ 1,00 \| máximo R\$ 10\.000,00\)_\n\n' +
      'Exemplo: `25` ou `50.00`',
    { parse_mode: 'MarkdownV2' }
  );
});

// ─── Seleção de produto ───────────────────────────────────────────────────────
bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produto...');
  const productId = ctx.match[1];
  const userId = ctx.from!.id;
  const session = await getSession(userId);

  let product: ProductDTO | undefined;
  let balanceResult = 0;

  try {
    const [products, walletData] = await Promise.all([
      apiClient.getProducts(),
      apiClient.getBalance(String(userId)).catch(() => ({ balance: 0, transactions: [] })),
    ]);
    product = products.find((p) => p.id === productId);
    session.products = products as never;
    balanceResult = Number(walletData.balance);
    await saveSession(userId, session);
  } catch (err) {
    captureError(err, { handler: 'select_product', productId, userId });
    await ctx.reply('❌ Erro ao buscar produto\. Tente novamente\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  if (!product) {
    await ctx.reply('❌ Produto não encontrado\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  if (product.stock != null && product.stock <= 0) {
    await ctx.reply('⚠️ Este produto está esgotado no momento\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  session.selectedProductId = productId;
  session.step = 'selecting_product';
  await saveSession(userId, session);

  await showPaymentMethodScreen(ctx, product, balanceResult);
});

// ─── Ações de pagamento ───────────────────────────────────────────────────────
bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('💰 Processando com saldo...');
  await executePayment(ctx, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Gerando PIX...');
  await executePayment(ctx, ctx.match[1], 'PIX');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🔀 Aplicando saldo + PIX...');
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🔍 Verificando pagamento...');
  await handleCheckPayment(ctx, ctx.match[1]);
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  await handleCancelPayment(ctx, ctx.match[1]);
});

// ─── Mensagens de texto livres ────────────────────────────────────────────────
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from!.id;
  const session = await getSession(userId);

  if (session.step === 'awaiting_deposit_amount') {
    await handleDepositAmount(ctx, text);
    return;
  }

  await ctx.reply(
    'Não entendi sua mensagem\. Use os botões abaixo para navegar:',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
        [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
        [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('❓ Ajuda', 'show_help')],
      ]).reply_markup,
    }
  );
});

// ─── Error handler global ─────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`[bot] Erro no update ${ctx.update.update_id}:`, err);
  captureError(err, { updateId: ctx.update.update_id, userId: ctx.from?.id });
});

// ─── Registro de comandos ─────────────────────────────────────────────────────
async function registerCommands(): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 Menu inicial' },
    { command: 'produtos', description: '🛒 Ver produtos disponíveis' },
    { command: 'saldo', description: '💰 Ver meu saldo e adicionar' },
    { command: 'meus_pedidos', description: '📦 Histórico de pedidos' },
    { command: 'ajuda', description: '❓ Central de ajuda e suporte' },
  ]);
  console.info('✅ Menu de comandos registrado no Telegram');
}

// ─── Inicialização ────────────────────────────────────────────────────────────
async function startBot(): Promise<void> {
  if (env.NODE_ENV === 'production' && env.BOT_WEBHOOK_URL) {
    const PORT = parseInt(process.env.PORT ?? '8080', 10);
    const webhookPath = '/telegram-webhook';
    const webhookUrl = `${env.BOT_WEBHOOK_URL}${webhookPath}`;

    await bot.telegram.setWebhook(webhookUrl, { secret_token: env.TELEGRAM_BOT_SECRET });
    console.info(`🤖 Webhook registrado: ${webhookUrl}`);

    const me = await bot.telegram.getMe();
    console.info(`📌 Bot username: @${me.username}`);

    await registerCommands();

    const app = express();
    app.use(express.json());

    app.post(webhookPath, async (req, res) => {
      const secretToken = req.headers['x-telegram-bot-api-secret-token'];
      if (env.TELEGRAM_BOT_SECRET && secretToken !== env.TELEGRAM_BOT_SECRET) {
        res.sendStatus(403);
        return;
      }

      res.sendStatus(200);

      const updateId: number | undefined = req.body?.update_id;
      if (updateId !== undefined) {
        const isNew = await markUpdateProcessed(updateId);
        if (!isNew) {
          console.warn(`[webhook] update_id ${updateId} duplicado — ignorado`);
          return;
        }
      }

      bot.handleUpdate(req.body).catch((err) => {
        console.error('[webhook] Erro ao processar update:', err);
        captureError(err, { context: 'handleUpdate', updateId });
      });
    });

    app.get('/health', (_req, res) => res.json({ status: 'ok', bot: me.username }));

    app.post('/internal/cache/invalidate-products', (req, res) => {
      const secret = req.headers['x-bot-secret'];
      if (secret !== env.TELEGRAM_BOT_SECRET) {
        res.sendStatus(403);
        return;
      }
      invalidateProductCache();
      invalidateBotConfigCache();
      console.info('[cache] Cache invalidado via API');
      res.json({ ok: true });
    });

    app.listen(PORT, () => {
      console.info(`🚀 Servidor webhook escutando na porta ${PORT}`);
    });
  } else {
    await bot.launch();
    console.info(`📌 Bot: @${bot.botInfo?.username}`);
    console.info('🤖 Bot iniciado em modo POLLING (desenvolvimento)');
    await registerCommands();
  }
}

startBot().catch((err) => {
  captureError(err, { context: 'startBot' });
  console.error('Falha ao iniciar o bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

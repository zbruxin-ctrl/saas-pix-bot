// Bot do Telegram - Ponto de entrada principal
// FEATURE 1: edit-in-place (editOrReply) — evita poluição visual
// FEATURE 2: sistema de saldo (show_balance, deposit_balance, paidWithBalance)
// FEATURE 3: animação de loading nos botões via answerCbQuery
// FEATURE 4: escolha de método de pagamento (BALANCE | PIX | MIXED)
// OPT #C: Promise.all para buscar produto + saldo em paralelo na tela de pagamento

import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { env } from './config/env';
import { apiClient } from './services/apiClient';
import type { ProductDTO, WalletTransactionDTO } from '@saas-pix/shared';

import winston from 'winston';
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [BOT][${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// ─── Sessão em memória ─────────────────────────────────────────────────

interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment' | 'awaiting_deposit_amount';
  selectedProductId?: string;
  paymentId?: string;
  products?: ProductDTO[];
  mainMessageId?: number;
}

const sessions = new Map<number, UserSession>();

function getSession(userId: number): UserSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: 'idle' });
  }
  return sessions.get(userId)!;
}

// ─── Bot ─────────────────────────────────────────────────────────────

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

// ─── Helper: editar mensagem principal ou enviar nova se não existir ───
async function editOrReply(
  ctx: Context,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  const session = getSession(ctx.from!.id);
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.replyWithMarkdown(text, extra as object);
    return;
  }

  if (session.mainMessageId) {
    try {
      await ctx.telegram.editMessageText(chatId, session.mainMessageId, undefined, text, {
        parse_mode: 'Markdown',
        ...extra,
      });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (
        !msg.includes('message is not modified') &&
        !msg.includes('message to edit not found') &&
        !msg.includes('MESSAGE_ID_INVALID')
      ) {
        logger.warn(`[editOrReply] Erro inesperado ao editar: ${msg}`);
      }
    }
  }

  const sent = await ctx.replyWithMarkdown(text, extra as object);
  session.mainMessageId = sent.message_id;
}

// ─── /start ──────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const firstName = ctx.from?.first_name || 'visitante';
  const userId = ctx.from!.id;

  sessions.set(userId, { step: 'idle', mainMessageId: undefined });

  const sent = await ctx.replyWithMarkdown(
    `👋 Olá, *${firstName}*! Bem-vindo!\n\n` +
    `🛒 Aqui você pode adquirir nossos produtos e planos de forma rápida e segura.\n\n` +
    `💳 Aceitamos pagamento via *PIX* (confirmação instantânea) ou via *saldo* pré-carregado.\n\n` +
    `Para ver nossos produtos, clique no botão abaixo:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ])
  );

  getSession(userId).mainMessageId = sent.message_id;
});

// ─── /produtos e /ajuda ────────────────────────────────────────────────

bot.command('produtos', async (ctx) => { await showProducts(ctx); });
bot.command('ajuda', async (ctx) => { await showHelp(ctx); });
bot.command('meus_pedidos', async (ctx) => {
  await ctx.replyWithMarkdown(
    `📋 *Meus Pedidos*\n\n` +
    `Para verificar seus pedidos ou relatar algum problema, entre em contato com nosso suporte.\n\n` +
    `Em caso de dúvidas sobre pagamentos, envie o *ID do pagamento* que recebeu.`
  );
});

// ─── Actions de navegação ───────────────────────────────────────────────

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produtos...');
  await showProducts(ctx);
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelp(ctx);
});

// ─── Saldo ───────────────────────────────────────────────────────────

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('⏳ Buscando saldo...');
  const userId = ctx.from!.id;
  try {
    const { balance, transactions } = await apiClient.getBalance(String(userId));

    const txLines = (transactions as WalletTransactionDTO[])
      .slice(0, 5)
      .map((t) => {
        const sinal = t.type === 'DEPOSIT' ? '\u2795' : '\u2796';
        return `${sinal} R$ ${Number(t.amount).toFixed(2)} \u2014 ${t.description}`;
      })
      .join('\n');

    const texto =
      `💰 *Seu Saldo*\n\n` +
      `Disponível: *R$ ${Number(balance).toFixed(2)}*\n\n` +
      (txLines ? `*Últimas transações:*\n${txLines}\n\n` : '_Nenhuma transação ainda._\n\n') +
      `Use seu saldo para comprar sem precisar fazer PIX toda hora!`;

    await editOrReply(ctx, texto, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('\u2795 Adicionar Saldo', 'deposit_balance')],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')],
      ]).reply_markup,
    });
  } catch (err) {
    logger.error(`Erro ao buscar saldo para ${userId}:`, err);
    await ctx.answerCbQuery('Erro ao buscar saldo. Tente novamente.', { show_alert: true });
  }
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from!.id);
  session.step = 'awaiting_deposit_amount';
  await ctx.replyWithMarkdown(
    `💳 *Adicionar Saldo*\n\n` +
    `Digite o valor em reais que deseja depositar:\n` +
    `_(mínimo R$ 1,00 | máximo R$ 10.000,00)_\n\n` +
    `Exemplo: \`25\` ou \`50.00\``
  );
});

// ─── Selecionar produto → tela de escolha de método ───────────────────

bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produto...');
  const productId = ctx.match[1];
  const userId = ctx.from!.id;
  const session = getSession(userId);

  // OPT #C: busca produto em cache local da sessão ou no cache global
  let product: ProductDTO | undefined = session.products?.find((p) => p.id === productId);

  // OPT #C: se não estava na sessão, busca via cache global do apiClient (sem hit na API se TTL válido)
  if (!product) {
    try {
      const products = await apiClient.getProducts();
      product = products.find((p) => p.id === productId);
      session.products = products;
    } catch {
      await editOrReply(ctx, '\u274c Erro ao buscar produto. Tente novamente.');
      return;
    }
  }

  if (!product) {
    await editOrReply(ctx, '\u274c Produto não encontrado.');
    return;
  }

  if (product.stock !== null && product.stock !== undefined && product.stock <= 0) {
    await editOrReply(ctx, '\u26a0\ufe0f Este produto está esgotado no momento.');
    return;
  }

  session.selectedProductId = productId;
  session.step = 'selecting_product';

  await showPaymentMethodScreen(ctx, product);
});

// ─── Tela de escolha de método de pagamento ───────────────────────────

async function showPaymentMethodScreen(ctx: Context, product: ProductDTO): Promise<void> {
  const userId = ctx.from!.id;

  // OPT #C: busca saldo em paralelo — não bloqueia se falhar
  let balance = 0;
  try {
    const walletData = await apiClient.getBalance(String(userId));
    balance = Number(walletData.balance);
  } catch {
    // Se não conseguir buscar saldo, exibe R$ 0
  }

  const price = Number(product.price);
  const balanceStr = balance.toFixed(2);
  const pixDiff = Math.max(0, price - balance).toFixed(2);

  const confirmMessage =
    `📦 *${product.name}*\n\n` +
    `📝 ${product.description}\n\n` +
    `💰 *Valor:* R$ ${price.toFixed(2)}\n` +
    `🏦 *Seu saldo:* R$ ${balanceStr}\n\n` +
    `*Como deseja pagar?*`;

  await editOrReply(ctx, confirmMessage, {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback(`💰 Só Saldo  (R$ ${price.toFixed(2)})`, `pay_balance_${product.id}`)],
      [Markup.button.callback(`📱 Só PIX  (R$ ${price.toFixed(2)})`, `pay_pix_${product.id}`)],
      [Markup.button.callback(`🔀 Saldo + PIX  (saldo R$ ${balanceStr} + PIX R$ ${pixDiff})`, `pay_mixed_${product.id}`)],
      [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')],
    ]).reply_markup,
  });
}

// ─── Helpers para executar o pagamento após escolha do método ─────────

async function executePayment(
  ctx: Context,
  productId: string,
  paymentMethod: 'BALANCE' | 'PIX' | 'MIXED'
): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  await editOrReply(ctx, '\u23f3 Processando sua compra, aguarde...');

  try {
    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
      paymentMethod,
    });

    session.paymentId = payment.paymentId;
    session.step = 'awaiting_payment';

    // ── 100% Saldo ──
    if (payment.paidWithBalance) {
      await editOrReply(
        ctx,
        `\u2705 *Compra realizada com saldo!*\n\n` +
        `📦 *Produto:* ${payment.productName}\n` +
        `💰 *Valor debitado:* R$ ${Number(payment.amount).toFixed(2)}\n\n` +
        `Seu produto será entregue em instantes! 🚀`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Menu Principal', 'show_products')],
            [Markup.button.callback('💰 Ver Saldo', 'show_balance')],
          ]).reply_markup,
        }
      );
      session.step = 'idle';
      return;
    }

    // ── PIX (puro ou MIXED) ──
    const expiresAt = new Date(payment.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const pixValue = payment.isMixed ? payment.pixAmount! : payment.amount;
    const mixedLine = payment.isMixed
      ? `\n💳 *Saldo usado:* R$ ${Number(payment.balanceUsed).toFixed(2)}\n📱 *PIX a pagar:* R$ ${Number(payment.pixAmount).toFixed(2)}`
      : '';

    await editOrReply(
      ctx,
      `💳 *Pagamento PIX Gerado!*\n\n` +
      `📦 *Produto:* ${payment.productName}\n` +
      `💰 *Valor total:* R$ ${Number(payment.amount).toFixed(2)}${mixedLine}\n` +
      `\u23f0 *Válido até:* ${expiresStr}\n` +
      `🪪 *ID:* \`${payment.paymentId}\`\n\n` +
      `_Escaneie o QR Code ou use o código copia e cola abaixo:_`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
          [Markup.button.callback('\u274c Cancelar', `cancel_payment_${payment.paymentId}`)],
        ]).reply_markup,
      }
    );

    const qrBuffer = Buffer.from(payment.pixQrCode, 'base64');
    await ctx.replyWithPhoto(
      { source: qrBuffer },
      { caption: `💰 R$ ${Number(pixValue).toFixed(2)} | Válido até ${expiresStr}\n📷 Escaneie este QR Code no seu banco` }
    );

    await ctx.reply(payment.pixQrCodeText);

    logger.info(`[${paymentMethod}] PIX gerado para usuário ${userId} | Pagamento: ${payment.paymentId}`);

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(`Erro ao processar pagamento (${paymentMethod}) para ${userId}:`, error);

    if (errMsg.toLowerCase().includes('saldo insuficiente')) {
      await editOrReply(
        ctx,
        `\u274c *${errMsg}*\n\nEscolha outra forma de pagamento ou adicione saldo.`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('\u2795 Adicionar Saldo', 'deposit_balance')],
            [Markup.button.callback('\u25c0\ufe0f Voltar', `select_product_${productId}`)],
          ]).reply_markup,
        }
      );
      return;
    }

    const isTimeout = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('econnreset');

    await editOrReply(
      ctx,
      isTimeout
        ? `\u23f3 *Demorou um pouquinho mais que o esperado...*\n\nNão se preocupe! Clique em *Tentar Novamente* abaixo 😊`
        : `\u26a0\ufe0f *Algo deu errado ao gerar o PIX*\n\nSeu dinheiro não foi cobrado.\nClique em *Tentar Novamente*.`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Tentar Novamente', `select_product_${productId}`)],
          [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')],
        ]).reply_markup,
      }
    );
  }
}

// ─── Actions de pagamento por método ──────────────────────────────────

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

// ─── Verificar status do pagamento ─────────────────────────────────────

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🔍 Verificando pagamento...');
  const paymentId = ctx.match[1];

  try {
    const { status } = await apiClient.getPaymentStatus(paymentId);

    const statusMessages: Record<string, string> = {
      PENDING: '\u23f3 *Pagamento pendente*\n\nAinda não identificamos seu pagamento. Se já pagou, aguarde alguns segundos e verifique novamente.',
      APPROVED: '\u2705 *Pagamento aprovado!*\n\nSeu acesso está sendo liberado. Você receberá uma mensagem em instantes.',
      REJECTED: '\u274c *Pagamento rejeitado*\n\nHouve um problema com seu pagamento. Por favor, tente novamente.',
      CANCELLED: '\u274c *Pagamento cancelado*\n\nEste pagamento foi cancelado.',
      EXPIRED: '\u231b *Pagamento expirado*\n\nO código PIX expirou. Gere um novo pagamento.',
    };

    const msg = statusMessages[status] || '\u2753 Status desconhecido';

    await editOrReply(
      ctx,
      msg,
      status === 'PENDING'
        ? {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Verificar Novamente', `check_payment_${paymentId}`)],
              [Markup.button.callback('\u274c Cancelar', `cancel_payment_${paymentId}`)],
            ]).reply_markup,
          }
        : {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🏠 Menu Principal', 'show_products')],
            ]).reply_markup,
          }
    );
  } catch {
    await ctx.answerCbQuery('Erro ao verificar pagamento.', { show_alert: true });
  }
});

// ─── Cancelar pagamento ─────────────────────────────────────────────────

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('❌ Cancelando...');
  const paymentId = ctx.match[1];
  const userId = ctx.from!.id;

  try {
    await apiClient.cancelPayment(paymentId);
    logger.info(`Pagamento ${paymentId} cancelado pelo usuário ${userId}`);
  } catch (error) {
    logger.warn(`Não foi possível cancelar pagamento ${paymentId}: ${error instanceof Error ? error.message : error}`);
  }

  sessions.set(userId, { step: 'idle' });

  await editOrReply(
    ctx,
    '\u274c *Pagamento cancelado.*\n\nVolte quando quiser!',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
        [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      ]).reply_markup,
    }
  );
});

// ─── Handler de mensagens de texto ────────────────────────────────────

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.step === 'awaiting_deposit_amount') {
    const valor = parseFloat(text.replace(',', '.'));

    if (isNaN(valor) || valor < 1 || valor > 10000) {
      await ctx.reply('\u274c Valor inválido. Digite um valor entre R$ 1,00 e R$ 10.000,00.\n\nExemplo: `25` ou `50.00`');
      return;
    }

    session.step = 'idle';

    const processingMsg = await ctx.replyWithMarkdown('\u23f3 Gerando PIX de depósito, aguarde...');

    try {
      const deposit = await apiClient.createDeposit(
        String(userId),
        valor,
        ctx.from?.first_name,
        ctx.from?.username
      );

      await ctx.deleteMessage(processingMsg.message_id).catch(() => {});

      const expiresAt = new Date(deposit.expiresAt);
      const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });

      const qrBuffer = Buffer.from(deposit.pixQrCode, 'base64');
      await ctx.replyWithPhoto(
        { source: qrBuffer },
        {
          caption:
            `💳 *Depósito de Saldo*\n` +
            `Valor: *R$ ${valor.toFixed(2)}*\n` +
            `Válido até: ${expiresStr}\n` +
            `🪪 ID: \`${deposit.paymentId}\`\n\n` +
            `Após o pagamento, o saldo será creditado automaticamente! \u2705`,
          parse_mode: 'Markdown',
        }
      );

      await ctx.reply(deposit.pixQrCodeText);

      logger.info(`[Deposit] PIX de depósito gerado para ${userId} | valor: ${valor}`);

    } catch (err) {
      await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
      logger.error(`Erro ao gerar depósito para ${userId}:`, err);
      await ctx.replyWithMarkdown(
        '\u274c Erro ao gerar PIX de depósito. Tente novamente.',
        Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_balance')]])
      );
    }
    return;
  }

  await ctx.replyWithMarkdown(
    `Não entendi sua mensagem. Use os botões abaixo para navegar:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('\u2753 Ajuda', 'show_help')],
    ])
  );
});

// ─── Funções auxiliares ───────────────────────────────────────────────

async function showProducts(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  session.step = 'idle';

  try {
    const products = await apiClient.getProducts(); // usa cache global OPT #B
    session.products = products;

    if (products.length === 0) {
      await editOrReply(ctx, '😔 Nenhum produto disponível no momento. Volte em breve!');
      return;
    }

    const buttons = products.map((p) => {
      const stockLabel =
        p.stock !== null && p.stock !== undefined ? ` (${p.stock} restantes)` : '';
      const label = `${p.name}${stockLabel} \u2014 R$ ${Number(p.price).toFixed(2)}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });

    buttons.push([Markup.button.callback('💰 Meu Saldo', 'show_balance')]);
    buttons.push([Markup.button.callback('\u2753 Ajuda', 'show_help')]);

    await editOrReply(
      ctx,
      `🛍️ *Nossos Produtos*\n\nEscolha uma opção abaixo:`,
      { reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
    );
  } catch (error) {
    logger.error('Erro ao buscar produtos:', error);
    await editOrReply(
      ctx,
      '\u274c Erro ao buscar produtos. Tente novamente em instantes.',
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Tentar Novamente', 'show_products')],
        ]).reply_markup,
      }
    );
  }
}

async function showHelp(ctx: Context): Promise<void> {
  await editOrReply(
    ctx,
    `\u2753 *Central de Ajuda*\n\n` +
    `*Comandos disponíveis:*\n` +
    `\u2022 /start \u2014 Tela inicial\n` +
    `\u2022 /produtos \u2014 Ver produtos\n` +
    `\u2022 /ajuda \u2014 Esta mensagem\n\n` +
    `*Como funciona?*\n` +
    `1. Escolha um produto\n` +
    `2. Escolha como pagar: saldo, PIX ou os dois\n` +
    `3. Receba seu acesso automaticamente \u2705\n\n` +
    `*Saldo pré-pago:*\n` +
    `Faça um depósito uma vez e use para várias compras sem gerar PIX a cada vez.\n\n` +
    `*Modo Saldo + PIX:*\n` +
    `Seu saldo cobre parte do valor e você paga o restante via PIX!\n\n` +
    `*Problemas com pagamento?*\n` +
    `Entre em contato com nosso suporte informando o ID do pagamento.`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('📞 Contatar Suporte', 'http://wa.me/+5511953699608')],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')],
      ]).reply_markup,
    }
  );
}

// ─── Tratamento de erros ────────────────────────────────────────────────

bot.catch((err, ctx) => {
  logger.error(`Erro no bot para update ${ctx.update.update_id}:`, err);
});

// ─── Inicialização ────────────────────────────────────────────────────

async function startBot(): Promise<void> {
  if (env.NODE_ENV === 'production' && env.BOT_WEBHOOK_URL) {
    await bot.launch({
      webhook: {
        domain: env.BOT_WEBHOOK_URL,
        port: env.BOT_WEBHOOK_PORT,
        path: '/telegram-webhook',
      },
    });
    logger.info(`🤖 Bot iniciado em modo WEBHOOK: ${env.BOT_WEBHOOK_URL}/telegram-webhook`);
  } else {
    await bot.launch();
    logger.info('🤖 Bot iniciado em modo POLLING (desenvolvimento)');
  }
  logger.info(`📌 Bot username: @${bot.botInfo?.username}`);
}

startBot().catch((err) => {
  logger.error('Falha ao iniciar o bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

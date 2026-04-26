// webhooks.ts
// FIX RACE: upsert com constraint UNIQUE (provider, externalId, eventType) garante que
//   mesmo que o MP dispare vários webhooks simultâneos, apenas UM processa a entrega.
//   O upsert tenta fazer UPDATE status='PROCESSING' onde status='PENDING' (ou INSERT).
//   Se o registro já existir com status='PROCESSING'/'PROCESSED'/'IGNORED', o update
//   não altera nada e retornamos imediatamente.
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { paymentService } from '../services/paymentService';
import { mercadoPagoService } from '../services/mercadoPagoService';
import { webhookRateLimit } from '../middleware/rateLimit';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export const webhooksRouter = Router();

const HANDLED_EVENTS = ['payment'];
const APPROVED_STATUS = 'approved';

const WEBHOOK_SECRET_PLACEHOLDER = 'dev_placeholder_troque_em_producao';
const isWebhookSignatureEnabled =
  env.MERCADO_PAGO_WEBHOOK_SECRET !== undefined &&
  env.MERCADO_PAGO_WEBHOOK_SECRET !== WEBHOOK_SECRET_PLACEHOLDER &&
  env.MERCADO_PAGO_WEBHOOK_SECRET.length >= 16;

if (!isWebhookSignatureEnabled && env.NODE_ENV === 'production') {
  logger.error(
    '\uD83D\uDEA8 [CR\u00cdTICO] MERCADO_PAGO_WEBHOOK_SECRET n\u00e3o configurado ou inv\u00e1lido no Railway. ' +
    'Valida\u00e7\u00e3o de assinatura DESABILITADA \u2014 configure a vari\u00e1vel imediatamente.'
  );
}

webhooksRouter.post(
  '/mercadopago',
  webhookRateLimit,
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const bodyString = rawBody.toString('utf-8');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyString);
    } catch {
      logger.warn('Webhook: payload inv\u00e1lido recebido');
      res.status(400).json({ error: 'Payload inv\u00e1lido' });
      return;
    }

    const isValid = isWebhookSignatureEnabled
      ? validateWebhookSignature(req, bodyString)
      : true;

    if (!isValid) {
      logger.warn('Webhook: assinatura inv\u00e1lida', { ip: req.ip });
      res.status(200).json({ status: 'ignored' });
      return;
    }

    if (!isWebhookSignatureEnabled && env.NODE_ENV === 'production') {
      logger.warn('Webhook aceito SEM valida\u00e7\u00e3o HMAC \u2014 configure MERCADO_PAGO_WEBHOOK_SECRET no Railway');
    }

    const eventType = payload.type as string;
    const dataId = (payload.data as { id?: string })?.id;
    const action = payload.action as string;

    logger.info(`Webhook recebido: tipo=${eventType} | action=${action} | id=${dataId}`);

    // Responde 200 imediatamente para o MP n\u00e3o retentar
    res.status(200).json({ status: 'received' });

    processWebhookAsync(eventType, dataId, payload).catch((error) => {
      logger.error('Erro no processamento ass\u00edncrono do webhook:', error);
    });
  }
);

async function processWebhookAsync(
  eventType: string,
  externalId: string | undefined,
  rawPayload: Record<string, unknown>
): Promise<void> {
  if (!externalId) {
    logger.warn('Webhook sem ID de pagamento, ignorando');
    return;
  }

  if (!HANDLED_EVENTS.includes(eventType)) {
    logger.info(`Webhook: tipo ${eventType} ignorado`);
    return;
  }

  // FIX RACE: tenta criar o registro com status PROCESSING.
  // Se j\u00e1 existir (unique constraint), o create falha e o update entra.
  // O update s\u00f3 muda para PROCESSING se ainda estiver PENDING.
  // Se j\u00e1 estiver PROCESSING/PROCESSED/IGNORED, o updateMany retorna count=0
  // e abortamos \u2014 garantindo que apenas UM processo executa a entrega.
  let webhookEventId: string;
  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider: 'mercado_pago',
        eventType,
        externalId,
        rawPayload: rawPayload as unknown as Prisma.InputJsonValue,
        status: 'PROCESSING',
      },
      select: { id: true },
    });
    webhookEventId = created.id;
  } catch (createError: any) {
    // Registro j\u00e1 existe (unique constraint) \u2014 tenta assumir o lock apenas se PENDING
    const existing = await prisma.webhookEvent.findUnique({
      where: {
        provider_externalId_eventType: {
          provider: 'mercado_pago',
          externalId,
          eventType,
        },
      },
      select: { id: true, status: true },
    });

    if (!existing) {
      logger.warn(`Webhook ${externalId}: registro desapareceu ap\u00f3s conflito, abortando`);
      return;
    }

    if (existing.status !== 'PENDING') {
      logger.info(`Webhook ${externalId}: status=${existing.status}, j\u00e1 processado/ignorado. Ignorando.`);
      return;
    }

    // Tenta fazer a transi\u00e7\u00e3o PENDING \u2192 PROCESSING atomicamente
    const locked = await prisma.webhookEvent.updateMany({
      where: { id: existing.id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });

    if (locked.count === 0) {
      // Outro processo ganhou a corrida
      logger.info(`Webhook ${externalId}: outro processo assumiu o lock, abortando`);
      return;
    }

    webhookEventId = existing.id;
  }

  // A partir daqui, apenas UM processo chega
  try {
    const mpPayment = await mercadoPagoService.getPaymentById(externalId);

    if (mpPayment.status !== APPROVED_STATUS) {
      logger.info(`Webhook: pagamento ${externalId} com status ${mpPayment.status}. Ignorando.`);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: 'IGNORED', processedAt: new Date() },
      });
      return;
    }

    const internalPayment =
      await prisma.payment.findUnique({ where: { mercadoPagoId: externalId } }) ||
      await prisma.payment.findUnique({ where: { id: mpPayment.external_reference } });

    if (!internalPayment) {
      logger.error(`Webhook: pagamento interno n\u00e3o encontrado para MP ID ${externalId}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: 'FAILED', error: 'Pagamento interno n\u00e3o encontrado', processedAt: new Date() },
      });
      return;
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { paymentId: internalPayment.id },
    });

    await paymentService.processApprovedPayment(internalPayment.id);

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Webhook processado com sucesso: pagamento ${internalPayment.id}`);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(`Erro ao processar webhook ${externalId}:`, error);
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { status: 'FAILED', error: errorMsg, processedAt: new Date() },
    }).catch(() => {});
  }
}

function validateWebhookSignature(req: Request, body: string): boolean {
  try {
    if (env.NODE_ENV === 'development') return true;

    const xSignature = req.headers['x-signature'] as string | undefined;
    const xRequestId = req.headers['x-request-id'] as string | undefined;

    if (!xSignature || !xRequestId) return false;

    const parts = xSignature.split(',');
    const tsPart = parts.find((p) => p.startsWith('ts='));
    const v1Part = parts.find((p) => p.startsWith('v1='));
    if (!tsPart || !v1Part) return false;

    const ts = tsPart.split('=')[1];
    const signature = v1Part.split('=')[1];

    let dataId = (req.query['data.id'] as string) || (req.query['id'] as string) || '';
    if (!dataId) {
      try { dataId = (JSON.parse(body)?.data?.id as string) || ''; } catch { /* ignore */ }
    }

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

    const expectedSignature = crypto
      .createHmac('sha256', env.MERCADO_PAGO_WEBHOOK_SECRET!)
      .update(manifest)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (error) {
    logger.error('Erro ao validar assinatura do webhook:', error);
    return false;
  }
}

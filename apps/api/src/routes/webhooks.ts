// webhooks.ts — webhook Mercado Pago com assinatura, idempotência e processamento assíncrono
// FIX L5: upsert não sobrescreve status IGNORED/FAILED de eventos já processados anteriormente
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
      logger.warn('Webhook: payload inválido recebido');
      res.status(400).json({ error: 'Payload inválido' });
      return;
    }

    const isValid = validateWebhookSignature(req, bodyString);
    if (!isValid) {
      logger.warn('Webhook: assinatura inválida', { ip: req.ip });
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const eventType = payload.type as string;
    const dataId = (payload.data as { id?: string })?.id;
    const action = payload.action as string;

    logger.info(`Webhook recebido: tipo=${eventType} | action=${action} | id=${dataId}`);

    res.status(200).json({ status: 'received' });

    processWebhookAsync(eventType, dataId, payload).catch((error) => {
      logger.error('Erro no processamento assíncrono do webhook:', error);
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

  // FIX L5: checa status ANTES do upsert.
  // IGNORED e FAILED NÃO devem ser sobrescritos para PROCESSING automaticamente.
  // PROCESSED também não — idempotência.
  const existingEvent = await prisma.webhookEvent.findUnique({
    where: {
      provider_externalId_eventType: {
        provider: 'mercado_pago',
        externalId,
        eventType,
      },
    },
  });

  if (existingEvent?.status === 'PROCESSED') {
    logger.info(`Webhook já processado: ${externalId}. Ignorando.`);
    return;
  }

  // FIX L5: não reprocessa eventos que foram explicitamente IGNORED
  if (existingEvent?.status === 'IGNORED') {
    logger.info(`Webhook marcado como IGNORED anteriormente: ${externalId}. Pulando.`);
    return;
  }

  const webhookEvent = await prisma.webhookEvent.upsert({
    where: {
      provider_externalId_eventType: {
        provider: 'mercado_pago',
        externalId,
        eventType,
      },
    },
    update: { status: 'PROCESSING' },
    create: {
      provider: 'mercado_pago',
      eventType,
      externalId,
      rawPayload: rawPayload as unknown as Prisma.InputJsonValue,
      status: 'PROCESSING',
    },
  });

  try {
    const mpPayment = await mercadoPagoService.getPaymentById(externalId);

    if (mpPayment.status !== APPROVED_STATUS) {
      logger.info(`Webhook: pagamento ${externalId} com status ${mpPayment.status}. Ignorando.`);
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'IGNORED', processedAt: new Date() },
      });
      return;
    }

    const internalPayment =
      await prisma.payment.findUnique({ where: { mercadoPagoId: externalId } }) ||
      await prisma.payment.findUnique({ where: { id: mpPayment.external_reference } });

    if (!internalPayment) {
      logger.error(`Webhook: pagamento interno não encontrado para MP ID ${externalId}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'FAILED', error: 'Pagamento interno não encontrado', processedAt: new Date() },
      });
      return;
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { paymentId: internalPayment.id },
    });

    await paymentService.processApprovedPayment(internalPayment.id);

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Webhook processado com sucesso: pagamento ${internalPayment.id}`);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(`Erro ao processar webhook ${externalId}:`, error);
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
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
      .createHmac('sha256', env.MERCADO_PAGO_WEBHOOK_SECRET)
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

// webhooks.ts — webhook Mercado Pago com assinatura, idempotência e processamento assíncrono
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

// POST /api/webhooks/mercadopago
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
      // Retorna 200 para não vazar informação de assinatura ao MP
      logger.warn('Webhook: assinatura inválida', { ip: req.ip });
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const eventType = payload.type as string;
    const dataId = (payload.data as { id?: string })?.id;
    const action = payload.action as string;

    logger.info(`Webhook recebido: tipo=${eventType} | action=${action} | id=${dataId}`);

    // Responde 200 imediatamente — processamento é assíncrono
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

  // Idempotência: checa se já foi PROCESSED antes do upsert
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

  // Evita processamento concorrente: só avança se conseguir upsert para PROCESSING
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

    // Busca pagamento interno pelo mercadoPagoId ou external_reference
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
    // Em desenvolvimento aceita sem assinatura para facilitar testes locais
    if (env.NODE_ENV === 'development') return true;

    const xSignature = req.headers['x-signature'] as string | undefined;
    const xRequestId = req.headers['x-request-id'] as string | undefined;

    // Sem cabeçalhos de assinatura = rejeita em produção
    if (!xSignature || !xRequestId) return false;

    const parts = xSignature.split(',');
    const tsPart = parts.find((p) => p.startsWith('ts='));
    const v1Part = parts.find((p) => p.startsWith('v1='));
    if (!tsPart || !v1Part) return false;

    const ts = tsPart.split('=')[1];
    const signature = v1Part.split('=')[1];

    // ID pode vir no query param ou no body
    let dataId = (req.query['data.id'] as string) || (req.query['id'] as string) || '';
    if (!dataId) {
      try { dataId = (JSON.parse(body)?.data?.id as string) || ''; } catch { /* ignore */ }
    }

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

    const expectedSignature = crypto
      .createHmac('sha256', env.MERCADO_PAGO_WEBHOOK_SECRET)
      .update(manifest)
      .digest('hex');

    // Comprimentos diferentes causam exceção em timingSafeEqual — protege antes de comparar
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (error) {
    logger.error('Erro ao validar assinatura do webhook:', error);
    return false;
  }
}

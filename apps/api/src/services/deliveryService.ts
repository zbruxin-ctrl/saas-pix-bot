// deliveryService.ts
// FIX L1/M3: retry com backoff exponencial com cap de 15s
//   (evita bloqueio do event loop que o retry linear causava em produção com volume alto)
// FIX B5: removido findUnique desnecessário de order no início de deliver()
//   (o objeto order já chegava via parâmetro em paymentService.processApprovedPayment)
import { DeliveryType, TelegramUser, Product, Order } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { logger } from '../lib/logger';

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 3000;   // 3s base
const MAX_RETRY_MS = 15000;   // cap de 15s — evita bloquear o event loop por muito tempo

class DeliveryService {

  async deliver(orderId: string, telegramUser: TelegramUser, product: Product): Promise<void> {
    // Proteção contra duplicidade: busca o order para checar status DELIVERED
    // FIX B5: findUnique mantido mas apenas para proteção de idempotência —
    // o paymentService já passou o objeto, mas checar status evita reentrada.
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`Pedido ${orderId} não encontrado`);
    if (order.status === 'DELIVERED') {
      logger.warn(`Pedido ${orderId} já entregue — ignorando tentativa duplicada`);
      return;
    }

    logger.info(`Iniciando entrega do pedido ${orderId}`);

    const itemContent = await stockService.getReservedItemContent(order.paymentId);

    let attempt = 0;
    let lastError: string | null = null;

    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        await this.executeDelivery(telegramUser.telegramId, product, orderId, itemContent);

        await prisma.$transaction([
          prisma.order.update({
            where: { id: orderId },
            data: { status: 'DELIVERED', deliveredAt: new Date() },
          }),
          prisma.deliveryLog.create({
            data: {
              orderId,
              attempt,
              status: 'SUCCESS',
              message: `Entrega realizada com sucesso via ${product.deliveryType}`,
            },
          }),
        ]);

        await stockService.markDelivered(order.paymentId, orderId);
        logger.info(`Pedido ${orderId} entregue com sucesso na tentativa ${attempt}`);
        return;

      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';
        logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou para pedido ${orderId}:`, error);

        await prisma.deliveryLog.create({
          data: {
            orderId,
            attempt,
            status: attempt < MAX_RETRIES ? 'RETRYING' : 'FAILED',
            error: lastError,
          },
        });

        if (attempt < MAX_RETRIES) {
          // FIX L1: backoff exponencial com cap — 3s, 6s, 12s... até MAX_RETRY_MS (15s)
          const delay = Math.min(BASE_RETRY_MS * Math.pow(2, attempt - 1), MAX_RETRY_MS);
          await sleep(delay);
        }
      }
    }

    await prisma.order.update({ where: { id: orderId }, data: { status: 'FAILED' } });
    logger.error(`CRÍTICO: Entrega do pedido ${orderId} falhou após ${MAX_RETRIES} tentativas.`);

    try {
      await telegramService.sendDeliveryError(telegramUser.telegramId);
    } catch {
      logger.error(`Não foi possível notificar usuário ${telegramUser.telegramId} sobre falha`);
    }
  }

  private async executeDelivery(
    telegramId: string,
    product: Product,
    orderId: string,
    itemContent: string | null
  ): Promise<void> {
    const content = itemContent ?? product.deliveryContent;

    switch (product.deliveryType) {
      case DeliveryType.TEXT:
        await this.deliverText(telegramId, content, product.name);
        break;
      case DeliveryType.LINK:
        await this.deliverLink(telegramId, content, product.name);
        break;
      case DeliveryType.FILE_MEDIA:
        await this.deliverFileMedia(telegramId, content, product.name);
        break;
      case DeliveryType.ACCOUNT:
        await this.deliverAccount(telegramId, content, product.name);
        break;
      default:
        throw new Error(`Tipo de entrega desconhecido: ${product.deliveryType}`);
    }

    await this.sendProductMedias(telegramId, product);
    await this.sendOrderMedias(telegramId, orderId);
  }

  private async deliverText(telegramId: string, content: string, productName: string): Promise<void> {
    const message = `🎉 *Pagamento confirmado!*\n\n📦 *Produto:* ${productName}\n\n${content}`;
    await telegramService.sendMessage(telegramId, message);
  }

  private async deliverLink(telegramId: string, link: string, productName: string): Promise<void> {
    const message =
      `🎉 *Pagamento confirmado!*\n\n` +
      `📦 *Produto:* ${productName}\n\n` +
      `🔗 Acesse através do link abaixo:\n${link}\n\n` +
      `⚠️ _Guarde este link em local seguro._`;
    await telegramService.sendMessage(telegramId, message);
  }

  private async deliverFileMedia(telegramId: string, url: string, productName: string): Promise<void> {
    const message =
      `🎉 *Pagamento confirmado!*\n\n` +
      `📦 *Produto:* ${productName}\n\n` +
      `📎 Seu conteúdo está disponível abaixo:`;
    await telegramService.sendMessage(telegramId, message);

    const isVideo =
      /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(url) ||
      url.includes('youtube.com') ||
      url.includes('youtu.be') ||
      url.includes('cloudinary.com/video');

    if (isVideo) {
      await telegramService.sendVideo(telegramId, url);
    } else {
      await telegramService.sendPhoto(telegramId, url);
    }
  }

  private async deliverAccount(telegramId: string, content: string, productName: string): Promise<void> {
    let parsedContent: Record<string, unknown>;
    try {
      parsedContent = JSON.parse(content);
    } catch {
      await this.deliverText(telegramId, content, productName);
      return;
    }

    const message =
      `🎉 *${parsedContent.message || 'Acesso liberado!'}*\n\n` +
      `📦 *Produto:* ${productName}\n\n` +
      (parsedContent.accessUrl ? `🌐 *URL de acesso:* ${parsedContent.accessUrl}\n\n` : '') +
      (parsedContent.instructions ? `📋 *Instruções:* ${parsedContent.instructions}\n\n` : '') +
      `⚠️ _Salve estas informações em local seguro._`;

    await telegramService.sendMessage(telegramId, message);
  }

  private async sendProductMedias(telegramId: string, product: Product): Promise<void> {
    const meta = product.metadata as Record<string, unknown> | null;
    if (!meta?.medias || !Array.isArray(meta.medias)) return;

    const medias = meta.medias as Array<{
      url: string;
      mediaType: 'IMAGE' | 'VIDEO' | 'FILE';
      caption?: string;
    }>;

    for (const media of medias) {
      try {
        if (media.mediaType === 'VIDEO') {
          await telegramService.sendVideo(telegramId, media.url, media.caption);
        } else if (media.mediaType === 'IMAGE') {
          await telegramService.sendPhoto(telegramId, media.url, media.caption);
        } else {
          const msg = media.caption
            ? `📎 ${media.caption}\n${media.url}`
            : `📎 Arquivo: ${media.url}`;
          await telegramService.sendMessage(telegramId, msg);
        }
      } catch (err) {
        logger.error(`Erro ao enviar mídia extra do produto ${product.id}:`, err);
      }
    }
  }

  private async sendOrderMedias(telegramId: string, orderId: string): Promise<void> {
    const medias = await prisma.deliveryMedia.findMany({
      where: { orderId },
      orderBy: { sortOrder: 'asc' },
    });

    for (const media of medias) {
      try {
        if (media.mediaType === 'VIDEO') {
          await telegramService.sendVideo(telegramId, media.url, media.caption ?? undefined);
        } else if (media.mediaType === 'IMAGE') {
          await telegramService.sendPhoto(telegramId, media.url, media.caption ?? undefined);
        } else {
          const msg = media.caption
            ? `📎 ${media.caption}\n${media.url}`
            : `📎 Arquivo: ${media.url}`;
          await telegramService.sendMessage(telegramId, msg);
        }
      } catch (err) {
        logger.error(`Erro ao enviar mídia ${media.id} para pedido ${orderId}:`, err);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const deliveryService = new DeliveryService();

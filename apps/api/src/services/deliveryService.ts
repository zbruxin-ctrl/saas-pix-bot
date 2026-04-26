// deliveryService.ts
// FEAT: mensagem de confirmaçao customizável via product.metadata.confirmationMessage
//       Variáveis: {{produto}}, {{conteudo}}
// FIX:  primeira mídia é enviada com a mensagem como caption (acoplada);
//       mídias adicionais são enviadas em sequência após.
import { DeliveryType, TelegramUser, Product } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { logger } from '../lib/logger';

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 3000;
const MAX_RETRY_MS = 15000;

type MediaEntry = {
  url: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'FILE';
  caption?: string;
};

/** Monta a mensagem de entrega — aplica template customizado ou retorna fallback padrão */
function buildConfirmationMessage(
  product: Product,
  content: string,
  deliveryType: DeliveryType
): string {
  const meta = product.metadata as Record<string, unknown> | null;
  const custom = meta?.confirmationMessage as string | undefined;

  if (custom && custom.trim()) {
    return custom
      .replace(/\{\{produto\}\}/g, product.name)
      .replace(/\{\{conteudo\}\}/g, content);
  }

  switch (deliveryType) {
    case DeliveryType.LINK:
      return (
        `🎉 *Pagamento confirmado!*\n\n` +
        `📦 *Produto:* ${product.name}\n\n` +
        `🔗 Acesse através do link abaixo:\n${content}\n\n` +
        `⚠️ _Guarde este link em local seguro._`
      );
    case DeliveryType.ACCOUNT:
      return `🎉 *Pagamento confirmado!*\n\n📦 *Produto:* ${product.name}\n\n${content}`;
    default:
      return `🎉 *Pagamento confirmado!*\n\n📦 *Produto:* ${product.name}\n\n${content}`;
  }
}

/**
 * Envia a mensagem de entrega acoplada à primeira mídia (como caption).
 * Se não houver mídias, envia como texto puro.
 * Mídias adicionais são enviadas em sequência com suas próprias captions.
 */
async function sendMessageWithMedias(
  telegramId: string,
  message: string,
  medias: MediaEntry[]
): Promise<void> {
  const validMedias = medias.filter((m) => m.url.trim());

  if (validMedias.length === 0) {
    await telegramService.sendMessage(telegramId, message);
    return;
  }

  const [first, ...rest] = validMedias;
  // Primeira mídia recebe a mensagem como caption
  await sendMedia(telegramId, first, message);

  // Mídias extras com suas próprias captions
  for (const media of rest) {
    await sendMedia(telegramId, media);
  }
}

async function sendMedia(
  telegramId: string,
  media: MediaEntry,
  captionOverride?: string
): Promise<void> {
  const caption = captionOverride ?? media.caption;
  try {
    if (media.mediaType === 'VIDEO') {
      await telegramService.sendVideo(telegramId, media.url, caption);
    } else if (media.mediaType === 'IMAGE') {
      await telegramService.sendPhoto(telegramId, media.url, caption);
    } else {
      // FILE: envia como link + caption no texto
      const msg = caption ? `${caption}\n📎 ${media.url}` : `📎 ${media.url}`;
      await telegramService.sendMessage(telegramId, msg);
    }
  } catch (err) {
    logger.error(`Erro ao enviar mídia ${media.url}:`, err);
    throw err;
  }
}

/** Coleta as mídias do produto salvas em metadata.medias */
function getProductMedias(product: Product): MediaEntry[] {
  const meta = product.metadata as Record<string, unknown> | null;
  if (!meta?.medias || !Array.isArray(meta.medias)) return [];
  return meta.medias as MediaEntry[];
}

/** Coleta as mídias do pedido da tabela DeliveryMedia */
async function getOrderMedias(orderId: string): Promise<MediaEntry[]> {
  const rows = await prisma.deliveryMedia.findMany({
    where: { orderId },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map((r) => ({
    url: r.url,
    mediaType: r.mediaType as 'IMAGE' | 'VIDEO' | 'FILE',
    caption: r.caption ?? undefined,
  }));
}

class DeliveryService {

  async deliver(orderId: string, telegramUser: TelegramUser, product: Product): Promise<void> {
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
    const content = itemContent ?? product.deliveryContent ?? '';

    const productMedias = getProductMedias(product);
    const orderMedias = await getOrderMedias(orderId);
    const allMedias = [...productMedias, ...orderMedias];

    switch (product.deliveryType) {
      case DeliveryType.TEXT:
      case DeliveryType.LINK: {
        const message = buildConfirmationMessage(product, content, product.deliveryType);
        await sendMessageWithMedias(telegramId, message, allMedias);
        break;
      }

      case DeliveryType.ACCOUNT: {
        const message = await this.buildAccountMessage(product, content);
        await sendMessageWithMedias(telegramId, message, allMedias);
        break;
      }

      case DeliveryType.FILE_MEDIA: {
        const isVideo =
          /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(content) ||
          content.includes('youtube.com') ||
          content.includes('youtu.be');

        const confirmMsg =
          `🎉 *Pagamento confirmado!*\n\n` +
          `📦 *Produto:* ${product.name}`;

        const mainMedia: MediaEntry = {
          url: content,
          mediaType: isVideo ? 'VIDEO' : 'IMAGE',
        };

        // Mídia principal com a mensagem de confirmação acoplada como caption
        await sendMedia(telegramId, mainMedia, confirmMsg);

        // Mídias extras
        for (const media of allMedias) {
          await sendMedia(telegramId, media);
        }
        break;
      }

      default:
        throw new Error(`Tipo de entrega desconhecido: ${product.deliveryType}`);
    }
  }

  private async buildAccountMessage(product: Product, content: string): Promise<string> {
    const meta = product.metadata as Record<string, unknown> | null;
    const custom = meta?.confirmationMessage as string | undefined;

    if (custom && custom.trim()) {
      return buildConfirmationMessage(product, content, DeliveryType.ACCOUNT);
    }

    let parsedContent: Record<string, unknown>;
    try {
      parsedContent = JSON.parse(content);
    } catch {
      return buildConfirmationMessage(product, content, DeliveryType.ACCOUNT);
    }

    return (
      `🎉 *${parsedContent.message || 'Acesso liberado!'}*\n\n` +
      `📦 *Produto:* ${product.name}\n\n` +
      (parsedContent.accessUrl ? `🌐 *URL de acesso:* ${parsedContent.accessUrl}\n\n` : '') +
      (parsedContent.instructions ? `📋 *Instruções:* ${parsedContent.instructions}\n\n` : '') +
      `⚠️ _Salve estas informações em local seguro._`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const deliveryService = new DeliveryService();

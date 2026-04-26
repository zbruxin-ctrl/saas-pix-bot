// stockService.ts — FIFO real por unidade via StockItem
// Ao criar pagamento: reserva a unidade mais antiga disponível (FIFO)
// Ao aprovar: confirma. Ao expirar/cancelar: libera.
import { StockItemStatus, StockReservationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const RESERVATION_TTL_MS = 30 * 60 * 1000;

export class StockService {

  // ─── FIFO: retorna estoque disponível por unidades individuais ───────────────
  async getAvailableStock(productId: string): Promise<number | null> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });
    if (!product) return 0;
    if (product.stock === null) return null; // ilimitado

    // Se o produto usa StockItem, conta unidades AVAILABLE
    const hasItems = await prisma.stockItem.count({ where: { productId } });
    if (hasItems > 0) {
      const available = await prisma.stockItem.count({
        where: { productId, status: StockItemStatus.AVAILABLE },
      });
      return available;
    }

    // Fallback: modelo antigo por reserva agregada
    const reserved = await prisma.stockReservation.count({
      where: {
        productId,
        status: StockReservationStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
    });
    return Math.max(0, product.stock - reserved);
  }

  // ─── FIFO: reserva a unidade mais antiga disponível ──────────────────────────
  async reserveStock(
    productId: string,
    telegramUserId: string,
    paymentId: string
  ): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });
    if (!product) throw new Error('Produto não encontrado.');

    const hasItems = await prisma.stockItem.count({ where: { productId } });

    if (hasItems > 0) {
      // Modo FIFO: reserva o item mais antigo disponível dentro de transação
      await prisma.$transaction(async (tx) => {
        const item = await tx.stockItem.findFirst({
          where: { productId, status: StockItemStatus.AVAILABLE },
          orderBy: { createdAt: 'asc' }, // FIFO
        });

        if (!item) throw new Error('Produto esgotado. Nenhuma unidade disponível.');

        await tx.stockItem.update({
          where: { id: item.id },
          data: {
            status: StockItemStatus.RESERVED,
            paymentId,
            reservedAt: new Date(),
          },
        });

        logger.info(
          `StockItem FIFO reservado | item=${item.id} | produto=${productId} | pagamento=${paymentId}`
        );
      });
      return;
    }

    // Fallback: modelo antigo por reserva agregada
    if (product.stock !== null) {
      const available = await this.getAvailableStock(productId);
      if (available !== null && available <= 0) {
        throw new Error('Produto esgotado. Estoque indisponível no momento.');
      }
    }

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
    await prisma.stockReservation.create({
      data: {
        productId,
        telegramUserId,
        paymentId,
        quantity: 1,
        status: StockReservationStatus.ACTIVE,
        expiresAt,
      },
    });
    logger.info(`Reserva (legado) criada | produto=${productId} | pagamento=${paymentId}`);
  }

  // ─── Confirma reserva após pagamento aprovado ─────────────────────────────
  async confirmReservation(paymentId: string): Promise<void> {
    // Tenta confirmar via StockItem (FIFO)
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    if (item) {
      if (item.status !== StockItemStatus.RESERVED) {
        logger.warn(`StockItem ${item.id} já está com status ${item.status}`);
        return;
      }
      await prisma.stockItem.update({
        where: { id: item.id },
        data: { status: StockItemStatus.CONFIRMED, confirmedAt: new Date() },
      });
      logger.info(`StockItem confirmado | item=${item.id} | pagamento=${paymentId}`);
      return;
    }

    // Fallback: modelo antigo
    await prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findUnique({
        where: { paymentId },
        include: { product: true },
      });
      if (!reservation) {
        logger.warn(`Nenhuma reserva encontrada para paymentId=${paymentId} — produto pode ser ilimitado`);
        return;
      }
      if (reservation.status !== StockReservationStatus.ACTIVE) {
        logger.warn(`Reserva ${reservation.id} já está com status ${reservation.status}`);
        return;
      }
      await tx.stockReservation.update({
        where: { id: reservation.id },
        data: { status: StockReservationStatus.CONFIRMED, confirmedAt: new Date() },
      });
      if (reservation.product.stock !== null) {
        await tx.product.update({
          where: { id: reservation.productId },
          data: { stock: { decrement: reservation.quantity } },
        });
      }
    });
  }

  // ─── Libera reserva (expiração, cancelamento) ─────────────────────────────
  async releaseReservation(paymentId: string, reason: string): Promise<void> {
    // Tenta liberar via StockItem
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    if (item) {
      if (item.status !== StockItemStatus.RESERVED) return;
      await prisma.stockItem.update({
        where: { id: item.id },
        data: { status: StockItemStatus.AVAILABLE, paymentId: null, reservedAt: null, releasedAt: new Date() },
      });
      logger.info(`StockItem liberado | item=${item.id} | motivo=${reason}`);
      return;
    }

    // Fallback: modelo antigo
    const reservation = await prisma.stockReservation.findUnique({ where: { paymentId } });
    if (!reservation || reservation.status !== StockReservationStatus.ACTIVE) return;
    await prisma.stockReservation.update({
      where: { id: reservation.id },
      data: { status: StockReservationStatus.RELEASED, releasedAt: new Date() },
    });
    logger.info(`Reserva (legado) liberada | id=${reservation.id} | motivo=${reason}`);
  }

  // ─── Marca StockItem como DELIVERED após entrega ──────────────────────────
  async markDelivered(paymentId: string, orderId: string): Promise<void> {
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    if (!item) return;
    await prisma.stockItem.update({
      where: { id: item.id },
      data: { status: StockItemStatus.DELIVERED, orderId, deliveredAt: new Date() },
    });
    logger.info(`StockItem entregue | item=${item.id} | pedido=${orderId}`);
  }

  // ─── Retorna o conteúdo da unidade reservada (para entrega FIFO) ──────────
  async getReservedItemContent(paymentId: string): Promise<string | null> {
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    return item?.content ?? null;
  }

  // ─── Job: libera reservas de StockItem expiradas ──────────────────────────
  async releaseExpiredReservations(): Promise<number> {
    // StockItem expirado: reservado há mais de 30 min e ainda RESERVED
    const cutoff = new Date(Date.now() - RESERVATION_TTL_MS);
    const expiredItems = await prisma.stockItem.findMany({
      where: { status: StockItemStatus.RESERVED, reservedAt: { lt: cutoff } },
      select: { id: true },
    });

    if (expiredItems.length > 0) {
      await prisma.stockItem.updateMany({
        where: { id: { in: expiredItems.map((i) => i.id) } },
        data: { status: StockItemStatus.AVAILABLE, paymentId: null, reservedAt: null, releasedAt: new Date() },
      });
      logger.info(`${expiredItems.length} StockItems expirados liberados (FIFO)`);
    }

    // Fallback: modelo antigo
    const legacyResult = await prisma.stockReservation.updateMany({
      where: { status: StockReservationStatus.ACTIVE, expiresAt: { lt: new Date() } },
      data: { status: StockReservationStatus.RELEASED, releasedAt: new Date() },
    });
    if (legacyResult.count > 0) {
      logger.info(`${legacyResult.count} reservas legadas expiradas liberadas`);
    }

    return expiredItems.length + legacyResult.count;
  }
}

export const stockService = new StockService();

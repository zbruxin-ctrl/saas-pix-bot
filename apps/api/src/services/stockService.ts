// Serviço de reserva temporária de estoque
// Reserva ao criar pagamento, confirma na aprovação, libera no timeout/cancelamento
import { StockReservationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 minutos

export class StockService {

  // Verifica se há estoque disponível (total - reservas ativas)
  async getAvailableStock(productId: string): Promise<number | null> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });

    if (!product) return 0;
    if (product.stock === null) return null; // ilimitado

    const reserved = await prisma.stockReservation.count({
      where: {
        productId,
        status: StockReservationStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
    });

    return Math.max(0, product.stock - reserved);
  }

  // Cria reserva temporária ao iniciar pagamento
  async reserveStock(
    productId: string,
    telegramUserId: string,
    paymentId: string
  ): Promise<void> {
    const available = await this.getAvailableStock(productId);

    if (available !== null && available <= 0) {
      throw new Error('Produto esgotado. Estoque indisponível no momento.');
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

    logger.info(`Estoque reservado | produto=${productId} | usuário=${telegramUserId} | expira=${expiresAt.toISOString()}`);
  }

  // Confirma reserva após pagamento aprovado e decrementa estoque real
  async confirmReservation(paymentId: string): Promise<void> {
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

      // Confirma a reserva
      await tx.stockReservation.update({
        where: { id: reservation.id },
        data: {
          status: StockReservationStatus.CONFIRMED,
          confirmedAt: new Date(),
        },
      });

      // Decrementa o estoque real do produto
      if (reservation.product.stock !== null) {
        await tx.product.update({
          where: { id: reservation.productId },
          data: { stock: { decrement: reservation.quantity } },
        });
        logger.info(`Estoque decrementado | produto=${reservation.productId} | qtd=${reservation.quantity}`);
      }
    });
  }

  // Libera reserva (expiração, cancelamento ou rejeição)
  async releaseReservation(paymentId: string, reason: string): Promise<void> {
    const reservation = await prisma.stockReservation.findUnique({
      where: { paymentId },
    });

    if (!reservation || reservation.status !== StockReservationStatus.ACTIVE) return;

    await prisma.stockReservation.update({
      where: { id: reservation.id },
      data: {
        status: StockReservationStatus.RELEASED,
        releasedAt: new Date(),
      },
    });

    logger.info(`Reserva liberada | id=${reservation.id} | motivo=${reason}`);
  }

  // Job: libera reservas expiradas (chamado a cada minuto)
  async releaseExpiredReservations(): Promise<number> {
    const result = await prisma.stockReservation.updateMany({
      where: {
        status: StockReservationStatus.ACTIVE,
        expiresAt: { lt: new Date() },
      },
      data: {
        status: StockReservationStatus.RELEASED,
        releasedAt: new Date(),
      },
    });

    if (result.count > 0) {
      logger.info(`${result.count} reservas expiradas liberadas automaticamente`);
    }

    return result.count;
  }
}

export const stockService = new StockService();

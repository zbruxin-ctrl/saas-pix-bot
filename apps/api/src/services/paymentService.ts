// paymentService.ts — cria pagamentos PIX com reserva FIFO via StockItem
// FIX #5: processApprovedPayment usa updateMany com WHERE status=PENDING dentro da transaction
//         para garantir que apenas um dos webhooks duplicados do MP processe o pagamento
import { PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import type { CreatePaymentRequest, CreatePaymentResponse } from '@saas-pix/shared';

export class PaymentService {
  async createPayment(data: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const { telegramId, productId, firstName, username } = data;

    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true },
    });
    if (!product) throw new AppError('Produto não encontrado ou indisponível.', 404);

    const telegramUser = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName, username },
      create: { telegramId, firstName, username },
    });

    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId,
        status: PaymentStatus.PENDING,
        pixExpiresAt: { gt: new Date() },
      },
    });

    if (existingPending) {
      logger.info(`Pagamento pendente reutilizado: ${existingPending.id}`);
      return {
        paymentId: existingPending.id,
        pixQrCode: existingPending.pixQrCode!,
        pixQrCodeText: existingPending.pixQrCodeText!,
        amount: Number(existingPending.amount),
        expiresAt: existingPending.pixExpiresAt!.toISOString(),
        productName: product.name,
      };
    }

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        amount: product.price,
        status: PaymentStatus.PENDING,
        metadata: { firstName, username, productName: product.name },
      },
    });

    if (product.stock !== null || (await this.productHasStockItems(productId))) {
      try {
        await stockService.reserveStock(productId, telegramUser.id, payment.id);
      } catch (err) {
        await prisma.payment.delete({ where: { id: payment.id } });
        throw err;
      }
    }

    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: Number(product.price),
        description: `${product.name} - SaaS PIX Bot`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: payment.id,
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      const raw = (mpPayment as { date_of_expiration?: string }).date_of_expiration;
      let pixExpiresAt = raw ? new Date(raw) : new Date(Date.now() + 30 * 60 * 1000);

      if (Number.isNaN(pixExpiresAt.getTime())) {
        pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      const updatedPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
          pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
          pixExpiresAt,
          status: PaymentStatus.PENDING,
        },
      });

      logger.info(`Pagamento criado: ${payment.id} | MP ID: ${mpPayment.id}`);

      return {
        paymentId: updatedPayment.id,
        pixQrCode: updatedPayment.pixQrCode!,
        pixQrCodeText: updatedPayment.pixQrCodeText!,
        amount: Number(updatedPayment.amount),
        expiresAt: updatedPayment.pixExpiresAt!.toISOString(),
        productName: product.name,
      };
    } catch (error) {
      await stockService.releaseReservation(payment.id, 'falha_criacao_mp');
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

  private async productHasStockItems(productId: string): Promise<boolean> {
    const count = await prisma.stockItem.count({ where: { productId } });
    return count > 0;
  }

  async processApprovedPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { product: true, telegramUser: true, order: true },
    });

    if (!payment) throw new AppError('Pagamento não encontrado', 404);

    if (payment.status === PaymentStatus.APPROVED) {
      logger.info(`Pagamento ${paymentId} já processado. Ignorando.`);
      return;
    }

    if (payment.status !== PaymentStatus.PENDING) {
      logger.warn(`Pagamento ${paymentId} com status ${payment.status}. Ignorando.`);
      return;
    }

    const { isApproved } = await mercadoPagoService.verifyPayment(
      payment.mercadoPagoId!,
      Number(payment.amount)
    );

    if (!isApproved) {
      logger.warn(`Pagamento ${paymentId} não verificado no MP. Ignorando.`);
      return;
    }

    // FIX #5: usa updateMany com WHERE status=PENDING como guarda atômica.
    // Se dois webhooks chegarem simultaneamente, apenas o primeiro vai atualizar
    // (count === 1) e o segundo vai encontrar count === 0 e sair sem criar Order duplicada.
    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
      });

      if (updated.count === 0) {
        // Outro processo já atualizou este pagamento — sai sem criar Order
        return null;
      }

      const newOrder = await tx.order.create({
        data: {
          paymentId: payment.id,
          telegramUserId: payment.telegramUserId,
          productId: payment.productId,
          status: 'PROCESSING',
        },
      });

      return newOrder;
    });

    if (!order) {
      logger.info(`Pagamento ${paymentId} já foi aprovado por outro processo. Ignorando.`);
      return;
    }

    await stockService.confirmReservation(paymentId);
    await deliveryService.deliver(order.id, payment.telegramUser, payment.product);
  }

  async cancelExpiredPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true },
    });

    if (!payment || payment.status !== PaymentStatus.PENDING) return;

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, cancelledAt: new Date() },
    });

    await stockService.releaseReservation(paymentId, 'pagamento_expirado');
    logger.info(`Pagamento ${paymentId} marcado como EXPIRADO e estoque liberado`);

    try {
      await telegramService.sendMessage(
        payment.telegramUser.telegramId,
        `⏰ *Pagamento expirado*\n\nSeu PIX não foi confirmado em 30 minutos e foi cancelado automaticamente.\n\nFique à vontade para tentar novamente! 😊`
      );
    } catch {
      logger.warn(`Não foi possível notificar usuário ${payment.telegramUser.telegramId} sobre expiração`);
    }
  }

  async getPaymentStatus(paymentId: string): Promise<{ status: PaymentStatus; paymentId: string }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true },
    });
    if (!payment) throw new AppError('Pagamento não encontrado', 404);
    return { status: payment.status, paymentId: payment.id };
  }
}

export const paymentService = new PaymentService();

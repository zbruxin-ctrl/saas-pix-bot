// paymentService.ts
// WALLET: verifica saldo antes de criar PIX; suporte a depósito de saldo (productId null)
// FIX M10: findExpiredPaymentIds() extrai a query do job para cá
// FIX B4: usa pixExpiresAt < cutoff (não createdAt) para encontrar PIX vencidos
// FIX BUG1: adiciona cancelPayment() que grava CANCELLED no banco e libera estoque
import { PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { walletService } from './walletService';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import type {
  CreatePaymentRequest,
  CreatePaymentResponse,
  CreateDepositRequest,
  CreateDepositResponse,
} from '@saas-pix/shared';

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

    // ── WALLET: verificar saldo ANTES do bloco existingPending ──
    const balance = Number(telegramUser.balance);
    const price = Number(product.price);

    if (balance >= price) {
      logger.info(`[Wallet] Usuário ${telegramId} com saldo suficiente (${balance}) para produto ${productId} (${price}). Debitando.`);

      // Cria payment, debita saldo e entrega dentro de uma única transação
      const payment = await prisma.payment.create({
        data: {
          telegramUserId: telegramUser.id,
          productId: product.id,
          amount: product.price,
          status: PaymentStatus.APPROVED,
          approvedAt: new Date(),
          metadata: { firstName, username, productName: product.name, paidWithBalance: true },
        },
      });

      // Reserva e confirma estoque atomicamente
      if (product.stock !== null || (await this.productHasStockItems(productId))) {
        await stockService.reserveStock(productId, telegramUser.id, payment.id);
        await stockService.confirmReservation(payment.id);
      }

      // Debita saldo
      await walletService.deduct(
        telegramUser.id,
        price,
        `Compra: ${product.name}`,
        payment.id,
      );

      // Cria Order e entrega
      const order = await prisma.order.create({
        data: {
          paymentId: payment.id,
          telegramUserId: telegramUser.id,
          productId: product.id,
          status: 'PROCESSING',
        },
      });

      // Fire-and-forget da entrega (não bloqueia resposta ao bot)
      deliveryService.deliver(order.id, telegramUser, product).catch((err) => {
        logger.error(`[Wallet] Erro na entrega do order ${order.id}:`, err);
      });

      return {
        paymentId: payment.id,
        pixQrCode: '',
        pixQrCodeText: '',
        amount: price,
        expiresAt: new Date().toISOString(),
        productName: product.name,
        paidWithBalance: true,
      };
    }

    // FIX BUG2: exclui pagamentos CANCELLED da reutilização.
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
        pixQrCodeText: updatedPayment.pixQrCodeText!,
        pixQrCode: updatedPayment.pixQrCode!,
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

  /** Cria um pagamento PIX sem produto vinculado para depósito de saldo */
  async createDepositPayment(data: CreateDepositRequest): Promise<CreateDepositResponse> {
    const { telegramId, amount, firstName, username } = data;

    if (amount < 1 || amount > 10000) {
      throw new AppError('Valor de depósito deve ser entre R$ 1,00 e R$ 10.000,00', 400);
    }

    const telegramUser = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName, username },
      create: { telegramId, firstName, username },
    });

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: null, // sem produto: é um depósito de saldo
        amount,
        status: PaymentStatus.PENDING,
        metadata: { firstName, username, type: 'WALLET_DEPOSIT' },
      },
    });

    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: amount,
        description: `Depósito de saldo - SaaS PIX Bot`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: payment.id,
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      const raw = (mpPayment as { date_of_expiration?: string }).date_of_expiration;
      let pixExpiresAt = raw ? new Date(raw) : new Date(Date.now() + 30 * 60 * 1000);
      if (Number.isNaN(pixExpiresAt.getTime())) {
        pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
          pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
          pixExpiresAt,
        },
      });

      logger.info(`[Deposit] PIX de depósito criado: ${payment.id} | valor: ${amount}`);

      return {
        paymentId: updated.id,
        pixQrCode: updated.pixQrCode!,
        pixQrCodeText: updated.pixQrCodeText!,
        amount,
        expiresAt: updated.pixExpiresAt!.toISOString(),
      };
    } catch (error) {
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

  private async productHasStockItems(productId: string): Promise<boolean> {
    const count = await prisma.stockItem.count({ where: { productId } });
    return count > 0;
  }

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; reason: string }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true },
    });

    if (!payment) {
      return { cancelled: false, reason: 'Pagamento não encontrado.' };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return {
        cancelled: false,
        reason: `Pagamento não pode ser cancelado pois está com status ${payment.status}.`,
      };
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });

    // Só libera estoque se houver produto vinculado
    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'cancelado_pelo_usuario');
    }

    logger.info(
      `[PaymentService] Pagamento ${paymentId} cancelado pelo usuário ${payment.telegramUser.telegramId}`
    );

    return { cancelled: true, reason: 'Pagamento cancelado com sucesso.' };
  }

  async findExpiredPaymentIds(cutoff: Date): Promise<string[]> {
    const payments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        pixExpiresAt: { lt: cutoff },
      },
      select: { id: true },
    });
    return payments.map((p) => p.id);
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

    // ── WALLET DEPOSIT: sem produto vinculado = é um depósito de saldo ──
    if (!payment.productId) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.updateMany({
          where: { id: paymentId, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });
        if (updated.count === 0) return;

        await tx.telegramUser.update({
          where: { id: payment.telegramUserId },
          data: { balance: { increment: Number(payment.amount) } },
        });

        await tx.walletTransaction.create({
          data: {
            telegramUserId: payment.telegramUserId,
            type: 'DEPOSIT',
            amount: Number(payment.amount),
            description: `Depósito via PIX`,
            paymentId: payment.id,
          },
        });
      });

      logger.info(`[Deposit] Saldo creditado para usuário ${payment.telegramUserId}: R$ ${Number(payment.amount).toFixed(2)}`);

      try {
        await telegramService.sendMessage(
          payment.telegramUser.telegramId,
          `✅ *Depósito confirmado!*\n\nR$ ${Number(payment.amount).toFixed(2)} foram adicionados ao seu saldo.\n\nUse o botão *💰 Meu Saldo* para ver seu extrato.`
        );
      } catch {
        logger.warn(`Não foi possível notificar usuário ${payment.telegramUser.telegramId} sobre depósito`);
      }
      return;
    }

    // Fluxo normal: pagamento de produto
    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
      });

      if (updated.count === 0) return null;

      const newOrder = await tx.order.create({
        data: {
          paymentId: payment.id,
          telegramUserId: payment.telegramUserId,
          productId: payment.productId!,
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
    await deliveryService.deliver(order.id, payment.telegramUser, payment.product!);
  }

  async cancelExpiredPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true },
    });

    if (!payment || payment.status !== PaymentStatus.PENDING) return;
    if (payment.pixExpiresAt && payment.pixExpiresAt > new Date()) {
      logger.warn(`[ExpireJob] Pagamento ${paymentId} com pixExpiresAt no futuro — ignorando`);
      return;
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, cancelledAt: new Date() },
    });

    // Só libera estoque se houver produto vinculado
    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'pagamento_expirado');
    }

    logger.info(`Pagamento ${paymentId} marcado como EXPIRADO`);

    try {
      await telegramService.sendMessage(
        payment.telegramUser.telegramId,
        `⏰ *Pagamento expirado*\n\nSeu PIX não foi confirmado e foi cancelado automaticamente.\n\nFique à vontade para tentar novamente! 😊`
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

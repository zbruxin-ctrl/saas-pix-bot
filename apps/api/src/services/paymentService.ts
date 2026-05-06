// paymentService.ts — reescrito para alinhar ao schema Prisma real
// Schema real: Payment.couponId (não couponCode), sem wallet model (balance em TelegramUser),
// WalletTransaction.telegramUserId (sem walletId), Order sem productName/amount/quantity,
// Referral.rewardPaid (não bonusPaid), WalletTransactionType sem BONUS,
// stockService.reserveStock(productId, telegramUserId, paymentId) — 3 args,
// deliveryService.deliver(orderId, telegramUser, product) — não deliverStock/consumeStock,
// couponService exportado como funções (não objeto), AppError em ../lib/AppError
import { PaymentStatus, OrderStatus, StockItemStatus, WalletTransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { stockService } from './stockService';
import * as couponService from './couponService';
import { logger } from '../lib/logger';
import { AppError } from '../lib/AppError';

// ─── Types ────────────────────────────────────────────────────────────────────

type ProductSnap = {
  id: string;
  name: string;
  price: import('@prisma/client').Prisma.Decimal;
  deliveryContent: string | null;
  stock: number | null;
};

// ─── Cache de status (TTL 5s) ─────────────────────────────────────────────────

const statusCacheTTL = 5_000;
const statusCache = new Map<string, { status: PaymentStatus; expiresAt: number }>();

// ─── Helper: reverte cupom ao expirar/cancelar ────────────────────────────────

async function revertCoupon(paymentId: string): Promise<void> {
  try {
    await couponService.revertCoupon(paymentId);
  } catch (err) {
    logger.warn(`[revertCoupon] falhou para ${paymentId}:`, err);
  }
}

// ─── paymentService ───────────────────────────────────────────────────────────

export const paymentService = {

  // ─── _payWithBalance ──────────────────────────────────────────────────────

  async _payWithBalance(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    amount: number;
    couponId?: string;
    referralCode?: string;
  }): Promise<{
    paymentId: string;
    paidWithBalance: true;
    productName: string;
    deliveryContent: string | null;
  }> {
    const { telegramUserId, product, qty, amount, couponId, referralCode } = opts;

    await stockService.reserveStock(product.id, telegramUserId, '__pending__');

    let paymentId: string | undefined;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.telegramUser.findUnique({
          where: { id: telegramUserId },
          select: { id: true, balance: true },
        });
        if (!user || Number(user.balance) < amount) {
          throw new AppError('Saldo insuficiente.', 400);
        }

        const payment = await tx.payment.create({
          data: {
            telegramUserId,
            productId: product.id,
            amount,
            status: PaymentStatus.APPROVED,
            paymentMethod: 'BALANCE',
            couponId: couponId ?? null,
            approvedAt: new Date(),
          },
        });

        await tx.telegramUser.update({
          where: { id: telegramUserId },
          data: { balance: { decrement: amount } },
        });

        await tx.walletTransaction.create({
          data: {
            telegramUserId,
            type: WalletTransactionType.PURCHASE,
            amount,
            description: `Compra: ${product.name}`,
            paymentId: payment.id,
          },
        });

        const order = await tx.order.create({
          data: {
            telegramUserId,
            paymentId: payment.id,
            productId: product.id,
            status: OrderStatus.PROCESSING,
          },
        });

        return { payment, order };
      });

      paymentId = result.payment.id;

      // Atualiza reserva com paymentId real
      await prisma.stockReservation.updateMany({
        where: { telegramUserId, productId: product.id, status: 'ACTIVE' },
        data: { paymentId: paymentId },
      });

      // Entrega
      const telegramUser = await prisma.telegramUser.findUniqueOrThrow({ where: { id: telegramUserId } });
      const productFull = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      await deliveryService.deliver(result.order.id, telegramUser, productFull);

      // Bônus de indicação
      if (referralCode) {
        try {
          const referrer = await prisma.telegramUser.findFirst({
            where: { telegramId: referralCode },
            select: { id: true },
          });
          if (referrer) {
            const referral = await prisma.referral.findFirst({
              where: { referredId: telegramUserId, referrerId: referrer.id },
            });
            if (referral && !referral.rewardPaid) {
              const bonus = Number(product.price) * 0.05;
              await prisma.telegramUser.update({
                where: { id: referrer.id },
                data: { balance: { increment: bonus } },
              });
              await prisma.walletTransaction.create({
                data: {
                  telegramUserId: referrer.id,
                  type: WalletTransactionType.REFERRAL_REWARD,
                  amount: bonus,
                  description: `Bônus de indicação: ${product.name}`,
                  paymentId: paymentId,
                },
              });
              await prisma.referral.update({
                where: { id: referral.id },
                data: { rewardPaid: true },
              });
            }
          }
        } catch (err) {
          logger.warn('[_payWithBalance] Falha ao pagar bônus de indicação:', err);
        }
      }

    } catch (err) {
      if (paymentId) {
        await stockService.releaseReservation(paymentId).catch(() => {});
      }
      throw err;
    }

    return {
      paymentId: paymentId!,
      paidWithBalance: true,
      productName: product.name,
      deliveryContent: product.deliveryContent,
    };
  },

  // ─── _payWithPix ──────────────────────────────────────────────────────────

  async _payWithPix(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    amount: number;
    couponId?: string;
    firstName?: string;
    username?: string;
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    expiresAt: string;
    productName: string;
  }> {
    const { telegramUserId, product, qty, amount, couponId, firstName, username } = opts;

    await stockService.reserveStock(product.id, telegramUserId, '__pending__');

    let paymentId: string | undefined;
    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        amount,
        description: product.name,
        payerEmail: `${telegramUserId}@telegram.bot`,
        firstName: firstName ?? 'Cliente',
        lastName: username ?? 'Telegram',
        externalReference: telegramUserId,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const payment = await prisma.payment.create({
        data: {
          telegramUserId,
          productId: product.id,
          amount,
          status: PaymentStatus.PENDING,
          paymentMethod: 'PIX',
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
          pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
          pixExpiresAt: expiresAt,
          couponId: couponId ?? null,
        },
      });

      paymentId = payment.id;

      await prisma.stockReservation.updateMany({
        where: { telegramUserId, productId: product.id, status: 'ACTIVE', paymentId: null },
        data: { paymentId: paymentId },
      });

      return {
        paymentId: payment.id,
        pixQrCode: payment.pixQrCode ?? '',
        pixQrCodeText: payment.pixQrCodeText ?? '',
        amount,
        expiresAt: expiresAt.toISOString(),
        productName: product.name,
      };
    } catch (err) {
      if (paymentId) {
        await stockService.releaseReservation(paymentId).catch(() => {});
      }
      throw err;
    }
  },

  // ─── _payWithMixed ────────────────────────────────────────────────────────

  async _payWithMixed(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    totalAmount: number;
    balanceAmount: number;
    pixAmount: number;
    couponId?: string;
    firstName?: string;
    username?: string;
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    pixAmount: number;
    balanceUsed: number;
    expiresAt: string;
    productName: string;
  }> {
    const { telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponId, firstName, username } = opts;

    await stockService.reserveStock(product.id, telegramUserId, '__pending__');

    let paymentId: string | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        const user = await tx.telegramUser.findUnique({
          where: { id: telegramUserId },
          select: { balance: true },
        });
        if (!user || Number(user.balance) < balanceAmount) {
          throw new AppError('Saldo insuficiente para pagamento misto.', 400);
        }
        await tx.telegramUser.update({
          where: { id: telegramUserId },
          data: { balance: { decrement: balanceAmount } },
        });
        await tx.walletTransaction.create({
          data: {
            telegramUserId,
            type: WalletTransactionType.PURCHASE,
            amount: balanceAmount,
            description: `Reserva saldo (misto): ${product.name}`,
          },
        });
      });

      const mpPayment = await mercadoPagoService.createPixPayment({
        amount: pixAmount,
        description: product.name,
        payerEmail: `${telegramUserId}@telegram.bot`,
        firstName: firstName ?? 'Cliente',
        lastName: username ?? 'Telegram',
        externalReference: telegramUserId,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const payment = await prisma.payment.create({
        data: {
          telegramUserId,
          productId: product.id,
          amount: totalAmount,
          pixAmount,
          balanceUsed: balanceAmount,
          status: PaymentStatus.PENDING,
          paymentMethod: 'MIXED',
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
          pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
          pixExpiresAt: expiresAt,
          couponId: couponId ?? null,
        },
      });

      paymentId = payment.id;

      await prisma.stockReservation.updateMany({
        where: { telegramUserId, productId: product.id, status: 'ACTIVE', paymentId: null },
        data: { paymentId: paymentId },
      });

      return {
        paymentId: payment.id,
        pixQrCode: payment.pixQrCode ?? '',
        pixQrCodeText: payment.pixQrCodeText ?? '',
        amount: totalAmount,
        pixAmount,
        balanceUsed: balanceAmount,
        expiresAt: expiresAt.toISOString(),
        productName: product.name,
      };
    } catch (err) {
      try {
        await prisma.telegramUser.update({
          where: { id: telegramUserId },
          data: { balance: { increment: balanceAmount } },
        });
      } catch {}
      if (paymentId) {
        await stockService.releaseReservation(paymentId).catch(() => {});
      }
      throw err;
    }
  },

  // ─── createPayment ────────────────────────────────────────────────────────

  async createPayment(opts: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod?: string;
    couponCode?: string;
    referralCode?: string;
  }) {
    const { telegramId, productId, firstName, username, paymentMethod = 'PIX', couponCode, referralCode } = opts;

    const [product, user] = await Promise.all([
      prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, price: true, deliveryContent: true, stock: true },
      }),
      prisma.telegramUser.upsert({
        where: { telegramId },
        update: { firstName: firstName ?? undefined, username: username ?? undefined },
        create: { telegramId, firstName: firstName ?? '', username: username ?? null },
        select: { id: true },
      }),
    ]);

    if (!product) throw new AppError('Produto não encontrado.', 404);

    const telegramUserId = user.id;
    const qty = 1;
    const baseAmount = Number(product.price) * qty;

    let couponId: string | undefined;
    let couponDiscount = 0;
    if (couponCode) {
      try {
        const result = await couponService.validateCoupon(couponCode, telegramId, baseAmount, productId);
        if (!result.valid || !result.couponId) throw new Error(result.error ?? 'Cupom inválido.');
        couponId = result.couponId;
        couponDiscount = result.discountAmount ?? 0;
      } catch {
        throw new AppError('Cupom inválido ou expirado.', 400);
      }
    }

    const totalAmount = Math.max(0, baseAmount - couponDiscount);

    if (paymentMethod === 'BALANCE') {
      const result = await this._payWithBalance({ telegramUserId, product, qty, amount: totalAmount, couponId, referralCode });
      return { ...result, amount: totalAmount };
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUserId, product, qty, amount: totalAmount, couponId, firstName, username });
    }

    // MIXED
    const userData = await prisma.telegramUser.findUnique({ where: { id: telegramUserId }, select: { balance: true } });
    const balanceAmount = Math.min(Number(userData?.balance ?? 0), totalAmount);
    const pixAmount = Math.max(0, totalAmount - balanceAmount);

    if (pixAmount <= 0) {
      const result = await this._payWithBalance({ telegramUserId, product, qty, amount: totalAmount, couponId, referralCode });
      return { ...result, amount: totalAmount };
    }

    return this._payWithMixed({ telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponId, firstName, username });
  },

  // ─── createDeposit ────────────────────────────────────────────────────────

  async createDeposit(opts: {
    telegramId: string;
    amount: number;
    firstName?: string;
    username?: string;
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    expiresAt: string;
  }> {
    const { telegramId, amount, firstName, username } = opts;

    const user = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName: firstName ?? undefined, username: username ?? undefined },
      create: { telegramId, firstName: firstName ?? '', username: username ?? null },
      select: { id: true },
    });

    const mpPayment = await mercadoPagoService.createPixPayment({
      amount,
      description: 'Depósito de saldo',
      payerEmail: `${telegramId}@telegram.bot`,
      firstName: firstName ?? 'Cliente',
      lastName: username ?? 'Telegram',
      externalReference: `deposit_${telegramId}`,
    });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: user.id,
        productId: null,
        amount,
        status: PaymentStatus.PENDING,
        paymentMethod: 'PIX',
        mercadoPagoId: String(mpPayment.id),
        pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
        pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
        pixExpiresAt: expiresAt,
      },
    });

    return {
      paymentId: payment.id,
      pixQrCode: payment.pixQrCode ?? '',
      pixQrCodeText: payment.pixQrCodeText ?? '',
      amount,
      expiresAt: expiresAt.toISOString(),
    };
  },

  // ─── confirmApproval ──────────────────────────────────────────────────────

  async confirmApproval(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true, product: true, order: true },
    });

    if (!payment) {
      logger.warn(`[confirmApproval] Pagamento não encontrado: ${paymentId}`);
      return;
    }

    if (payment.approvedAt) {
      logger.info(`[confirmApproval] Pagamento já aprovado: ${paymentId}`);
      return;
    }

    // É um depósito (sem produto)
    if (!payment.product || !payment.productId) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });
        await tx.telegramUser.update({
          where: { id: payment.telegramUserId },
          data: { balance: { increment: Number(payment.amount) } },
        });
        await tx.walletTransaction.create({
          data: {
            telegramUserId: payment.telegramUserId,
            type: WalletTransactionType.DEPOSIT,
            amount: Number(payment.amount),
            description: 'Depósito via PIX',
            paymentId,
          },
        });
      });
      statusCache.delete(paymentId);
      return;
    }

    const product = payment.product;
    const telegramUser = payment.telegramUser;

    try {
      let order = payment.order;

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });

        if (!order) {
          order = await tx.order.create({
            data: {
              telegramUserId: payment.telegramUserId,
              paymentId,
              productId: product.id,
              status: OrderStatus.PROCESSING,
            },
          });
        } else {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.PROCESSING },
          });
        }
      });

      await deliveryService.deliver(order!.id, telegramUser, product);

      statusCache.delete(paymentId);
    } finally {
      await stockService.releaseReservation(paymentId).catch(() => {});
    }
  },

  // Alias para admin/payments.ts (:id/reprocess)
  processApprovedPayment(paymentId: string): Promise<void> {
    return this.confirmApproval(paymentId);
  },

  // ─── handleMercadoPagoWebhook ─────────────────────────────────────────────

  async handleMercadoPagoWebhook(data: { action?: string; data?: { id?: string } }): Promise<void> {
    if (data.action !== 'payment.updated' && data.action !== 'payment.created') return;
    const mpId = data.data?.id;
    if (!mpId) return;

    setImmediate(async () => {
      try {
        const mpStatus = await mercadoPagoService.verifyPayment(mpId);
        if (mpStatus !== 'approved') return;

        const payment = await prisma.payment.findFirst({
          where: { mercadoPagoId: mpId },
          select: { id: true, status: true },
        });

        if (!payment) {
          logger.warn(`[webhook] Pagamento não encontrado para mercadoPagoId: ${mpId}`);
          return;
        }

        if (payment.status !== PaymentStatus.PENDING) {
          logger.info(`[webhook] Pagamento ${payment.id} já processado (status: ${payment.status})`);
          return;
        }

        await paymentService.confirmApproval(payment.id);
      } catch (err) {
        logger.error('[webhook] Erro ao processar webhook:', err);
      }
    });
  },

  // ─── findExpiredPaymentIds (usado por expirePayments.ts) ──────────────────

  async findExpiredPaymentIds(now: Date): Promise<string[]> {
    const payments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        pixExpiresAt: { lt: now },
      },
      select: { id: true },
    });
    return payments.map((p) => p.id);
  },

  // ─── cancelExpiredPayment ─────────────────────────────────────────────────

  async cancelExpiredPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, mercadoPagoId: true },
    });

    if (!payment || payment.status !== PaymentStatus.PENDING) return;

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
    });

    await stockService.releaseReservation(paymentId).catch(() => {});
    await revertCoupon(paymentId);

    if (payment.mercadoPagoId) {
      mercadoPagoService.refundPayment(payment.mercadoPagoId).catch((err) =>
        logger.warn(`[cancelExpiredPayment] Falha ao cancelar PIX no MP (${payment.mercadoPagoId}): ignorado`, err)
      );
    }

    statusCache.delete(paymentId);
  },

  // ─── getPaymentStatus ─────────────────────────────────────────────────────

  async getPaymentStatus(paymentId: string): Promise<{
    status: PaymentStatus;
    approvedAt?: string;
    productName?: string;
    deliveryContent?: string | null;
  }> {
    const now = Date.now();
    const cached = statusCache.get(paymentId);
    if (cached && cached.expiresAt > now) {
      return { status: cached.status };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        approvedAt: true,
        pixExpiresAt: true,
        mercadoPagoId: true,
        productId: true,
        product: { select: { name: true, deliveryContent: true } },
      },
    });

    if (!payment) throw new AppError('Pagamento não encontrado.', 404);

    let status = payment.status;

    if (status === PaymentStatus.PENDING && payment.pixExpiresAt && payment.pixExpiresAt < new Date()) {
      status = PaymentStatus.EXPIRED;
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
      });
      await stockService.releaseReservation(paymentId).catch(() => {});
      await revertCoupon(paymentId);
      if (payment.mercadoPagoId) {
        mercadoPagoService.refundPayment(payment.mercadoPagoId).catch(() => {});
      }
    }

    statusCache.set(paymentId, { status, expiresAt: now + statusCacheTTL });
    return {
      status,
      ...(payment.approvedAt ? { approvedAt: payment.approvedAt.toISOString() } : {}),
      ...(status === PaymentStatus.APPROVED && payment.product
        ? {
            productName: payment.product.name ?? undefined,
            deliveryContent: payment.product.deliveryContent ?? null,
          }
        : {}),
    };
  },

  // ─── cancelPayment ────────────────────────────────────────────────────────

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message?: string }> {
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId },
      select: { status: true, mercadoPagoId: true },
    });

    if (!payment) {
      return { cancelled: false, message: 'Pagamento não encontrado.' };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return { cancelled: false, message: `Pagamento não pode ser cancelado (status: ${payment.status}).` };
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });

    await stockService.releaseReservation(paymentId).catch(() => {});
    await revertCoupon(paymentId);

    if (payment.mercadoPagoId) {
      mercadoPagoService.refundPayment(payment.mercadoPagoId).catch(() => {});
    }

    statusCache.delete(paymentId);
    return { cancelled: true };
  },

  // ─── getAvailableStock ────────────────────────────────────────────────────

  async getAvailableStock(productId: string): Promise<number | null> {
    const items = await prisma.stockItem.count({
      where: { productId, status: StockItemStatus.AVAILABLE },
    });
    return items;
  },
};

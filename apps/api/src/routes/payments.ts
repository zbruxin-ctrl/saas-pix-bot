// Rotas de pagamento (usadas pelo bot)
// FIX BUG8: GET /products movido para ANTES de GET /:id/status (Express capturava /products como /:id)
// FIX BUG1: adiciona POST /:id/cancel para que o bot possa gravar CANCELLED no banco
// FIX STOCK-DISPLAY: /products agora retorna availableStock calculado corretamente
// WALLET: adiciona POST /deposit e GET /balance
// SORT: /products ordena por sortOrder, depois createdAt
// OPT #5 v2: /products usa 1 groupBy para todos os COUNTs (elimina N queries separadas)
// OPT #11: /balance resolve com include em 1 query ao invés de 2 sequenciais
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StockItemStatus } from '@prisma/client';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  telegramId: z.string().min(1),
  productId: z.string().min(1),
  firstName: z.string().optional(),
  username: z.string().optional(),
  paymentMethod: z.string().optional(),
});

const createDepositSchema = z.object({
  telegramId: z.string().min(1),
  amount: z.number().min(1).max(10000),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

// ─── Rotas estáticas PRIMEIRO (antes de qualquer /:param) ─────────────────────

// POST /api/payments/create
paymentsRouter.post(
  '/create',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const data = createPaymentSchema.parse(req.body);
    const result = await paymentService.createPayment(data as Parameters<typeof paymentService.createPayment>[0]);
    logger.info(`Pagamento criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// POST /api/payments/deposit
paymentsRouter.post(
  '/deposit',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const data = createDepositSchema.parse(req.body);
    const result = await paymentService.createDepositPayment(data);
    logger.info(`[Deposit] PIX de depósito criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// GET /api/payments/balance?telegramId=xxx
// OPT #11: 1 query com include ao invés de findUnique + findMany sequenciais
paymentsRouter.get(
  '/balance',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { telegramId } = req.query as { telegramId?: string };
    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: {
        id: true,
        balance: true,
        walletTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            type: true,
            amount: true,
            description: true,
            paymentId: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      res.json({ success: true, data: { balance: 0, transactions: [] } });
      return;
    }

    res.json({
      success: true,
      data: {
        balance: Number(user.balance),
        transactions: user.walletTransactions.map((t) => ({
          ...t,
          amount: Number(t.amount),
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  }
);

// GET /api/payments/products
// OPT #5 v2: 1 groupBy para buscar todos os COUNTs de stock disponível de uma vez,
//            ao invés de N prisma.stockItem.count separados (elimina N+1 real)
// IMPORTANTE: deve ficar ANTES de GET /:id/status
paymentsRouter.get(
  '/products',
  requireBotSecret,
  async (_req: Request, res: Response) => {
    // Busca produtos e contagem de stock disponível em PARALELO
    const [products, stockCounts] = await Promise.all([
      prisma.product.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          deliveryType: true,
          stock: true,
          sortOrder: true,
          metadata: true,
          _count: { select: { stockItems: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      // 1 query de groupBy substitui N queries de count separadas
      prisma.stockItem.groupBy({
        by: ['productId'],
        where: { status: StockItemStatus.AVAILABLE },
        _count: { id: true },
      }),
    ]);

    // Monta mapa produtoId → qtd disponível para lookup O(1)
    const stockMap = new Map<string, number>();
    for (const s of stockCounts) {
      stockMap.set(s.productId, s._count.id);
    }

    const productsWithStock = products.map((p) => {
      let availableStock: number | null;

      if (p._count.stockItems > 0) {
        // Usa o mapa: 0 se não apareceu no groupBy (nenhum AVAILABLE)
        availableStock = stockMap.get(p.id) ?? 0;
      } else if (p.stock !== null) {
        availableStock = p.stock;
      } else {
        availableStock = null;
      }

      return {
        id: p.id,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        deliveryType: p.deliveryType,
        sortOrder: p.sortOrder,
        metadata: p.metadata,
        availableStock,
      };
    });

    const available = productsWithStock.filter(
      (p) => p.availableStock === null || p.availableStock > 0
    );

    res.json({ success: true, data: available });
  }
);

// ─── Rotas dinâmicas DEPOIS das estáticas ─────────────────────────────────────

// POST /api/payments/:id/cancel
paymentsRouter.post(
  '/:id/cancel',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = await paymentService.cancelPayment(id);
    if (!result.cancelled) {
      res.status(400).json({ success: false, message: result.reason });
      return;
    }
    logger.info(`Pagamento ${id} cancelado via bot`);
    res.json({ success: true, message: result.reason });
  }
);

// GET /api/payments/:id/status
paymentsRouter.get(
  '/:id/status',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const status = await paymentService.getPaymentStatus(id);
    res.json({ success: true, data: status });
  }
);

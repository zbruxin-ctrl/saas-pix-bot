// Rotas de pagamento (usadas pelo bot)
// FIX BUG1: adiciona POST /:id/cancel para que o bot possa gravar CANCELLED no banco
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';

export const paymentsRouter = Router();

// Schema de validação para criação de pagamento
const createPaymentSchema = z.object({
  telegramId: z.string().min(1),
  productId: z.string().min(1),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

// Cria um pagamento PIX
// POST /api/payments/create
paymentsRouter.post(
  '/create',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const data = createPaymentSchema.parse(req.body);

    const result = await paymentService.createPayment(data);

    logger.info(`Pagamento criado via API: ${result.paymentId}`);

    res.status(201).json({
      success: true,
      data: result,
    });
  }
);

// Cancela um pagamento PENDING a pedido do usuário no bot
// POST /api/payments/:id/cancel
// FIX BUG1: antes o bot só parava de mostrar o QR Code localmente;
// agora grava CANCELLED no banco, liberando o estoque e atualizando o painel.
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

// Verifica status de um pagamento
// GET /api/payments/:id/status
paymentsRouter.get(
  '/:id/status',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const status = await paymentService.getPaymentStatus(id);

    res.json({
      success: true,
      data: status,
    });
  }
);

// Lista produtos disponíveis (usado pelo bot)
// GET /api/payments/products
paymentsRouter.get(
  '/products',
  requireBotSecret,
  async (_req: Request, res: Response) => {
    const { prisma } = await import('../lib/prisma');

    const products = await prisma.product.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        deliveryType: true,
        stock: true,
        metadata: true,
      },
      orderBy: { price: 'asc' },
    });

    res.json({
      success: true,
      data: products.map((p) => ({
        ...p,
        price: Number(p.price),
      })),
    });
  }
);

// routes/admin/adminProducts.ts — roles corrigidas (SUPERADMIN) + DeliveryType alinhado
import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminProductsRouter = Router();

const productSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().min(5).max(500),
  price: z.number().positive().max(99999),
  deliveryType: z.enum(['TEXT', 'LINK', 'FILE_MEDIA', 'ACCOUNT']),
  deliveryContent: z.string().min(1),
  isActive: z.boolean().default(true),
  stock: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

adminProductsRouter.get('/', async (_req, res: Response) => {
<<<<<<< HEAD
  const products = await prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    data: products.map((p) => ({ ...p, price: Number(p.price) })),
  });
});

// GET /api/admin/products/:id
adminProductsRouter.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
  });

  if (!product) {
    return res.status(404).json({
      success: false,
      error: 'Produto não encontrado',
    });
  }

  res.json({
    success: true,
    data: { ...product, price: Number(product.price) },
  });
});

// POST /api/admin/products
=======
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ success: true, data: products.map((p) => ({ ...p, price: Number(p.price) })) });
});

adminProductsRouter.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
  res.json({ success: true, data: { ...product, price: Number(product.price) } });
});

>>>>>>> 5d6c0b3 (descrição do que mudou)
adminProductsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.parse(req.body);

    const product = await prisma.product.create({
      data: {
        ...data,
        metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });

    res.status(201).json({
      success: true,
      data: { ...product, price: Number(product.price) },
    });
  }
);

adminProductsRouter.put(
  '/:id',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.partial().parse(req.body);

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...data,
        metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });

    res.json({
      success: true,
      data: { ...product, price: Number(product.price) },
    });
  }
);

adminProductsRouter.delete(
  '/:id',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true });
  }
);

// ─── StockItem CRUD (para cadastrar unidades individuais de estoque FIFO) ────
const stockItemSchema = z.object({
  content: z.string().min(1),
});

// GET /api/admin/products/:productId/stock-items
adminProductsRouter.get(
  '/:productId/stock-items',
  async (req: AuthenticatedRequest, res: Response) => {
    const items = await prisma.stockItem.findMany({
      where: { productId: req.params.productId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: items });
  }
);

// POST /api/admin/products/:productId/stock-items
adminProductsRouter.post(
  '/:productId/stock-items',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { content } = stockItemSchema.parse(req.body);
    const item = await prisma.stockItem.create({
      data: { productId: req.params.productId, content, status: 'AVAILABLE' },
    });
    res.status(201).json({ success: true, data: item });
  }
);

// DELETE /api/admin/products/stock-items/:itemId
adminProductsRouter.delete(
  '/stock-items/:itemId',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.stockItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  }
);

// ─── Mídias de entrega por pedido ─────────────────────────────────────────────
const mediaSchema = z.object({
  url: z.string().url(),
  mediaType: z.enum(['IMAGE', 'VIDEO', 'FILE']),
  caption: z.string().max(500).optional(),
  sortOrder: z.number().int().default(0),
});

<<<<<<< HEAD
// GET /api/admin/orders/:orderId/medias
adminProductsRouter.get(
  '/orders/:orderId/medias',
  async (req: AuthenticatedRequest, res: Response) => {
    const medias = await prisma.deliveryMedia.findMany({
      where: { orderId: req.params.orderId },
      orderBy: { sortOrder: 'asc' },
    });

    res.json({ success: true, data: medias });
  }
);
=======
adminProductsRouter.get('/orders/:orderId/medias', async (req: AuthenticatedRequest, res: Response) => {
  const medias = await prisma.deliveryMedia.findMany({
    where: { orderId: req.params.orderId },
    orderBy: { sortOrder: 'asc' },
  });
  res.json({ success: true, data: medias });
});
>>>>>>> 5d6c0b3 (descrição do que mudou)

adminProductsRouter.post(
  '/orders/:orderId/medias',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = mediaSchema.parse(req.body);

    const media = await prisma.deliveryMedia.create({
      data: { orderId: req.params.orderId, ...data },
    });

    res.status(201).json({ success: true, data: media });
  }
);

adminProductsRouter.delete(
  '/orders/medias/:mediaId',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.deliveryMedia.delete({ where: { id: req.params.mediaId } });
    res.json({ success: true });
  }
);

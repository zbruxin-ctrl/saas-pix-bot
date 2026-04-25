// Rota admin de produtos — DeliveryType simplificado + gerenciamento de mídias
import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminProductsRouter = Router();

// Tipos de entrega simplificados
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

// GET /api/admin/products
adminProductsRouter.get('/', async (_req, res: Response) => {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    success: true,
    data: products.map((p) => ({ ...p, price: Number(p.price) })),
  });
});

// POST /api/admin/products
adminProductsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.parse(req.body);
    const product = await prisma.product.create({
      data: { ...data, metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined },
    });
    res.status(201).json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

// PUT /api/admin/products/:id
adminProductsRouter.put(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.partial().parse(req.body);
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { ...data, metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined },
    });
    res.json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

// DELETE (soft delete) /api/admin/products/:id
adminProductsRouter.delete(
  '/:id',
  requireRole('SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true });
  }
);

// ─── Mídias de entrega por pedido ──────────────────────────────────────────

const mediaSchema = z.object({
  url: z.string().url(),
  mediaType: z.enum(['IMAGE', 'VIDEO', 'FILE']),
  caption: z.string().max(500).optional(),
  sortOrder: z.number().int().default(0),
});

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

// POST /api/admin/orders/:orderId/medias
adminProductsRouter.post(
  '/orders/:orderId/medias',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = mediaSchema.parse(req.body);
    const media = await prisma.deliveryMedia.create({
      data: { orderId: req.params.orderId, ...data },
    });
    res.status(201).json({ success: true, data: media });
  }
);

// DELETE /api/admin/orders/medias/:mediaId
adminProductsRouter.delete(
  '/orders/medias/:mediaId',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.deliveryMedia.delete({ where: { id: req.params.mediaId } });
    res.json({ success: true });
  }
);

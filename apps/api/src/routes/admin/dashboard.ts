// ALTERAÇÕES: adicionadas métricas operacionais (expirados, cancelados, reembolsados,
// falhas de entrega hoje, falhas de webhook hoje, pedidos com falha)
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthenticatedRequest } from '../../middleware/auth';

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalApproved,
    totalPending,
    totalRejected,
    totalExpired,
    totalCancelled,
    totalRefunded,
    revenueResult,
    todayPayments,
    todayRevenue,
    monthPayments,
    monthRevenue,
    deliveriesFailedToday,
    webhooksFailedToday,
    ordersWithFailure,
    recentPayments,
  ] = await Promise.all([
    prisma.payment.count({ where: { status: 'APPROVED' } }),
    prisma.payment.count({ where: { status: 'PENDING' } }),
    prisma.payment.count({ where: { status: { in: ['REJECTED'] } } }),
    prisma.payment.count({ where: { status: 'EXPIRED' } }),
    prisma.payment.count({ where: { status: 'CANCELLED' } }),
    prisma.payment.count({ where: { status: 'REFUNDED' } }),
    prisma.payment.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
    }),
    prisma.payment.count({
      where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
    }),
    prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
      _sum: { amount: true },
    }),
    prisma.payment.count({
      where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
    }),
    prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    // Logs de entrega com falha hoje
    prisma.deliveryLog.count({
      where: { status: 'FAILED', createdAt: { gte: startOfToday } },
    }),
    // Webhooks com falha hoje
    prisma.webhookEvent.count({
      where: { status: 'FAILED', createdAt: { gte: startOfToday } },
    }),
    // Pedidos com status FAILED (entrega mal-sucedida)
    prisma.order.count({ where: { status: 'FAILED' } }),
    // Últimos 10 pagamentos aprovados
    prisma.payment.findMany({
      where: { status: 'APPROVED' },
      include: {
        product: { select: { name: true } },
        telegramUser: { select: { username: true, firstName: true } },
      },
      orderBy: { approvedAt: 'desc' },
      take: 10,
    }),
  ]);

  res.json({
    success: true,
    data: {
      stats: {
        totalRevenue: Number(revenueResult._sum.amount || 0),
        totalApproved,
        totalPending,
        totalRejected,
        totalExpired,
        totalCancelled,
        totalRefunded,
        revenueToday: Number(todayRevenue._sum.amount || 0),
        paymentsToday: todayPayments,
        revenueThisMonth: Number(monthRevenue._sum.amount || 0),
        paymentsThisMonth: monthPayments,
        deliveriesFailedToday,
        webhooksFailedToday,
        ordersWithFailure,
      },
      recentPayments: recentPayments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        approvedAt: p.approvedAt,
        productName: p.product.name,
        userName: p.telegramUser.firstName || p.telegramUser.username || 'Sem nome',
      })),
    },
  });
});

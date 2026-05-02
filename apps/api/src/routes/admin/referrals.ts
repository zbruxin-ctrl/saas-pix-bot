// routes/admin/referrals.ts
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminReferralsRouter = Router();
adminReferralsRouter.use(requireRole('ADMIN', 'SUPERADMIN'));

adminReferralsRouter.get('/summary', async (_req: AuthenticatedRequest, res: Response) => {
  const [total, paid, unpaid] = await Promise.all([
    prisma.referral.count(),
    prisma.referral.count({ where: { rewardPaid: true } }),
    prisma.referral.count({ where: { rewardPaid: false } }),
  ]);
  const [paidSum, unpaidSum] = await Promise.all([
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: true } }),
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: false } }),
  ]);
  res.json({
    success: true,
    data: {
      total, paid, unpaid,
      totalPaidAmount:   Number(paidSum._sum.rewardAmount   ?? 0),
      totalUnpaidAmount: Number(unpaidSum._sum.rewardAmount ?? 0),
    },
  });
});

adminReferralsRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const page  = Math.max(1, Number(req.query.page  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const skip  = (page - 1) * limit;
  const search = req.query.search as string | undefined;
  const where = search ? {
    OR: [
      { referrer: { firstName: { contains: search, mode: 'insensitive' as const } } },
      { referrer: { username:  { contains: search, mode: 'insensitive' as const } } },
      { referrer: { telegramId: search } },
      { referred: { firstName: { contains: search, mode: 'insensitive' as const } } },
      { referred: { username:  { contains: search, mode: 'insensitive' as const } } },
      { referred: { telegramId: search } },
    ],
  } : {};

  const [referrals, total, agg, totalConverted] = await Promise.all([
    prisma.referral.findMany({
      skip, take: limit, where,
      orderBy: { createdAt: 'desc' },
      include: {
        referrer: { select: { telegramId: true, firstName: true, username: true } },
        referred: { select: { telegramId: true, firstName: true, username: true } },
        payment:  { select: { id: true, amount: true, status: true, approvedAt: true } },
      },
    }),
    prisma.referral.count({ where }),
    prisma.referral.aggregate({ _count: { _all: true }, _sum: { rewardAmount: true } }),
    prisma.referral.count({ where: { rewardPaid: true } }),
  ]);

  const data = referrals.map((r) => ({
    id:         r.id,
    referrer:   r.referrer,
    referred:   r.referred,
    createdAt:  r.createdAt,
    converted:  r.rewardPaid,
    rewardPaid: Number(r.rewardAmount ?? 0),
  }));

  res.json({
    success: true,
    data,
    total,
    totalPages: Math.ceil(total / limit),
    page,
    summary: {
      totalReferrals:   agg._count._all,
      totalConverted,
      totalRewardsPaid: Number(agg._sum.rewardAmount ?? 0),
    },
  });
});

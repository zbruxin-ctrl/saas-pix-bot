// routes/admin/referrals.ts
// FIX-REFERRAL-STATS: summary agora distingue 3 estados:
//   - registered  = entrou pelo link mas ainda não comprou    (rewardPaid:false, paymentId:null)
//   - pending     = usou o link na compra, recompensa a pagar (rewardPaid:false, paymentId:not null)
//   - converted   = recompensa já paga                        (rewardPaid:true)
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminReferralsRouter = Router();
adminReferralsRouter.use(requireRole('ADMIN', 'SUPERADMIN'));

adminReferralsRouter.get('/summary', async (_req: AuthenticatedRequest, res: Response) => {
  const [total, converted, pendingPayment] = await Promise.all([
    prisma.referral.count(),
    prisma.referral.count({ where: { rewardPaid: true } }),
    prisma.referral.count({ where: { rewardPaid: false, paymentId: { not: null } } }),
  ]);

  const registered = total - converted - pendingPayment;

  const [paidSum, pendingSum] = await Promise.all([
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: true } }),
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: false, paymentId: { not: null } } }),
  ]);

  res.json({
    success: true,
    data: {
      total,
      // Indicados que ainda não fizeram a primeira compra
      registered,
      // Indicados que compraram mas recompensa ainda não foi processada
      pendingPayment,
      // Indicados convertidos com recompensa paga
      converted,
      totalPaidAmount:    Number(paidSum._sum.rewardAmount   ?? 0),
      totalPendingAmount: Number(pendingSum._sum.rewardAmount ?? 0),
    },
  });
});

adminReferralsRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const page  = Math.max(1, Number(req.query.page  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const skip  = (page - 1) * limit;
  const search = req.query.search as string | undefined;

  // filtro por estado: all | registered | pending | converted
  const stateFilter = req.query.state as string | undefined;
  const stateWhere: Record<string, unknown> =
    stateFilter === 'converted'  ? { rewardPaid: true } :
    stateFilter === 'pending'    ? { rewardPaid: false, paymentId: { not: null } } :
    stateFilter === 'registered' ? { rewardPaid: false, paymentId: null } :
    {};

  const searchWhere = search ? {
    OR: [
      { referrer: { firstName: { contains: search, mode: 'insensitive' as const } } },
      { referrer: { username:  { contains: search, mode: 'insensitive' as const } } },
      { referrer: { telegramId: search } },
      { referred: { firstName: { contains: search, mode: 'insensitive' as const } } },
      { referred: { username:  { contains: search, mode: 'insensitive' as const } } },
      { referred: { telegramId: search } },
    ],
  } : {};

  const where = { ...stateWhere, ...searchWhere };

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
    // Estado do referral:
    //   registered = sem paymentId (indicado ainda não comprou)
    //   pending    = paymentId existe mas rewardPaid=false
    //   converted  = rewardPaid=true
    state:      r.rewardPaid ? 'converted' : r.paymentId ? 'pending' : 'registered',
    rewardPaid: Number(r.rewardAmount ?? 0),
    payment:    r.payment ?? null,
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

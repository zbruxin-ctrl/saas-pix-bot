// referrals.ts — rotas do programa de indicação
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireBotSecret } from '../middleware/auth';
import { registerReferral } from '../services/referralService';
import { prisma } from '../lib/prisma';

export const referralsRouter = Router();

const registerSchema = z.object({
  referrerTelegramId: z.string().min(1),
  referredTelegramId: z.string().min(1),
});

// POST /api/referrals/register
referralsRouter.post(
  '/register',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0].message });
      return;
    }

    const { referrerTelegramId, referredTelegramId } = parsed.data;
    const result = await registerReferral(referrerTelegramId, referredTelegramId);

    if (!result.registered) {
      res.json({ success: false, reason: result.reason });
      return;
    }

    res.json({ success: true });
  }
);

// GET /api/referrals/info?telegramId=xxx  (chamado pelo bot)
// GET /api/referrals/stats?telegramId=xxx (alias — mantém compatibilidade)
// Retorna: referralCount, purchaseCount, bonusEarned, referralCode
async function getReferralStats(req: Request, res: Response): Promise<void> {
  const { telegramId } = req.query as { telegramId?: string };

  if (!telegramId) {
    res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
    return;
  }

  const user = await prisma.telegramUser.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  if (!user) {
    res.json({
      success: true,
      data: { referralCount: 0, purchaseCount: 0, bonusEarned: 0, referralCode: telegramId },
    });
    return;
  }

  const referrals = await prisma.referral.findMany({
    where: { referrerId: user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      rewardPaid: true,
      rewardAmount: true,
      createdAt: true,
      referred: { select: { firstName: true, username: true } },
    },
  });

  // purchaseCount = indicados que tiveram recompensa paga (fizeram ao menos 1 compra)
  const purchaseCount = referrals.filter((r) => r.rewardPaid).length;
  const bonusEarned = referrals
    .filter((r) => r.rewardPaid)
    .reduce((sum, r) => sum + Number(r.rewardAmount), 0);

  res.json({
    success: true,
    data: {
      referralCount: referrals.length,
      purchaseCount,
      bonusEarned: parseFloat(bonusEarned.toFixed(2)),
      referralCode: telegramId,
    },
  });
}

referralsRouter.get('/info',  requireBotSecret, getReferralStats);
referralsRouter.get('/stats', requireBotSecret, getReferralStats);

// pricingService.ts — volume tiers (desconto por quantidade)
import { prisma } from '../lib/prisma';

export interface TierResult {
  tierId: string | null;
  discountPercent: number;
  originalAmount: number;
  finalAmount: number;
}

/**
 * Retorna o melhor VolumeTier aplicável para o produto + quantidade.
 * Prioridade: tier específico do produto > tier global (productId null)
 */
export async function getEffectiveTier(
  productId: string,
  qty: number
): Promise<TierResult | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { price: true },
  });
  if (!product) return null;

  const originalAmount = Number(product.price) * qty;

  // Busca tiers específicos e globais de uma vez
  const tiers = await prisma.volumeTier.findMany({
    where: {
      OR: [
        { productId, minQty: { lte: qty } },
        { productId: null, minQty: { lte: qty } },
      ],
    },
    orderBy: { minQty: 'desc' },
  });

  if (tiers.length === 0) {
    return { tierId: null, discountPercent: 0, originalAmount, finalAmount: originalAmount };
  }

  // Prefere tier específico do produto; se empate de minQty, específico vence
  const specific = tiers.filter((t) => t.productId === productId);
  const global = tiers.filter((t) => t.productId === null);
  const best = specific[0] ?? global[0];

  const discountPercent = Number(best.discountPercent);
  const finalAmount = parseFloat(
    (originalAmount * (1 - discountPercent / 100)).toFixed(2)
  );

  return { tierId: best.id, discountPercent, originalAmount, finalAmount };
}

/**
 * Aplica o tier ao amount base e retorna o valor final.
 * Se não houver tier, retorna o amount original.
 */
export async function applyVolumeTier(
  productId: string,
  qty: number
): Promise<{ amount: number; discountPercent: number; originalAmount: number }> {
  const result = await getEffectiveTier(productId, qty);
  if (!result) return { amount: Number((await prisma.product.findUnique({ where: { id: productId }, select: { price: true } }))!.price) * qty, discountPercent: 0, originalAmount: 0 };
  return { amount: result.finalAmount, discountPercent: result.discountPercent, originalAmount: result.originalAmount };
}

/**
 * Gerenciamento de sessões de usuário via Redis (Upstash HTTP).
 * Em dev sem Upstash, usa fallback em memória (InMemoryRedis no redis.ts).
 *
 * P1 FIX: sessions migradas para Redis — sem perda de contexto em restart.
 * FIX #1: campo pixExpiresAt adicionado — permite re-agendar o timer de
 *         expiração do PIX ao receber /start após um restart do bot.
 * FIX-BUILD: adiciona 'awaiting_coupon' ao step + pendingProductId/pendingCoupon à interface
 * FIX-COUPON-DISCOUNT: adiciona pendingCouponDiscount para persistir valor de desconto entre telas
 * FEAT-COPYPASTE-CHECK: adiciona pixQrCodeText para reenviar copia e cola ao verificar pagamento
 * FIX-SESSION-TTL: TTL dinâmico por estado — sessões com PIX pendente expiram
 *   em 35min (margem sobre os 30min do PIX) em vez de ficar 1h no Redis.
 * AUDIT #14: getSession renova TTL do Redis (via saveSession) ao carregar sessão
 *   existente — sem isso, sessões de usuários ativos podiam expirar no Redis se
 *   o caller não chamasse saveSession ao final da operação.
 * FEAT-MULTI-QTY: adiciona pendingQty para compra múltipla de produtos.
 *   step 'awaiting_quantity' adicionado para a tela de seleção de quantidade.
 */
import { redis } from './redis';

export interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment' | 'awaiting_deposit_amount' | 'awaiting_coupon' | 'awaiting_quantity';
  selectedProductId?: string;
  paymentId?: string;
  /** ISO string com a data/hora de expiração do PIX em aberto (FIX #1) */
  pixExpiresAt?: string;
  /** Copia e Cola do PIX gerado — reexibido ao verificar pagamento pendente */
  pixQrCodeText?: string;
  depositPaymentId?: string;
  depositMessageId?: number;
  mainMessageId?: number;
  firstName?: string;
  lastActivityAt: number;
  /** Produto pendente enquanto aguarda input de cupom ou seleção de quantidade */
  pendingProductId?: string;
  /** Cupom digitado pelo usuário, antes de confirmar pagamento */
  pendingCoupon?: string | null;
  /** Valor do desconto do cupom (em reais) para exibir na tela de pagamento */
  pendingCouponDiscount?: number;
  /** Quantidade de unidades selecionada na tela de compra múltipla */
  pendingQty?: number;
  /** Armazena produtos em cache local na sessão para evitar re-fetch */
  products?: never;
}

/** TTL em segundos por estado da sessão */
function getTTL(step: UserSession['step']): number {
  switch (step) {
    case 'awaiting_payment':
      return 35 * 60;
    case 'awaiting_deposit_amount':
    case 'awaiting_coupon':
    case 'awaiting_quantity':
      return 10 * 60;
    default:
      return 60 * 60;
  }
}

function sessionKey(userId: number): string {
  return `session:${userId}`;
}

export async function getSession(userId: number): Promise<UserSession> {
  const raw = await redis.get(sessionKey(userId));
  if (raw) {
    const session: UserSession = JSON.parse(raw);
    session.lastActivityAt = Date.now();
    await redis.set(sessionKey(userId), JSON.stringify(session), getTTL(session.step));
    return session;
  }
  return { step: 'idle', lastActivityAt: Date.now() };
}

export async function saveSession(userId: number, session: UserSession): Promise<void> {
  session.lastActivityAt = Date.now();
  const ttl = getTTL(session.step);
  await redis.set(sessionKey(userId), JSON.stringify(session), ttl);
}

export async function clearSession(userId: number, keepFirstName?: string): Promise<void> {
  await saveSession(userId, {
    step: 'idle',
    firstName: keepFirstName,
    lastActivityAt: Date.now(),
  });
}

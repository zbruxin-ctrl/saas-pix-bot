/**
 * Locks distribuídos via Redis (SET NX) — Upstash HTTP.
 * Funciona corretamente com múltiplas instâncias do bot.
 *
 * P1 FIX: locks migrados para Redis — sem race condition com 2+ instâncias.
 * P1 FIX: processedUpdateIds migrado para Redis — sem duplicatas em restart.
 */
import { redis } from './redis';

/**
 * Tenta adquirir um lock. Retorna true se adquiriu, false se já estava bloqueado.
 * @param key        Identificador único do lock (ex: `pay:${userId}`, `cancel:${paymentId}`)
 * @param ttlSeconds Tempo máximo de vida do lock em segundos
 */
export async function acquireLock(key: string, ttlSeconds = 30): Promise<boolean> {
  return redis.setnx(`lock:${key}`, '1', ttlSeconds);
}

/**
 * Libera um lock explicitamente (mesmo antes do TTL expirar).
 */
export async function releaseLock(key: string): Promise<void> {
  await redis.del(`lock:${key}`);
}

/**
 * Verifica se um update_id já foi processado (idempotência de webhooks).
 * Retorna true se é NOVO (pode processar), false se já foi visto.
 * TTL 5 minutos — Telegram reenvia por no máximo 24h, mas IDs recentes bastam.
 */
export async function markUpdateProcessed(updateId: number): Promise<boolean> {
  return redis.setnx(`update:${updateId}`, '1', 300);
}

/**
 * Camada de abstração para Redis via Upstash (HTTP — sem Docker).
 * Em desenvolvimento sem as vars UPSTASH_*, usa um Map em memória como fallback.
 *
 * Upstash oferece plano gratuito em: https://upstash.com
 * Após criar um banco Redis, copie UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN
 * para o .env e para as variáveis de ambiente do Railway.
 */
import { env } from '../config/env';

interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exSeconds?: number): Promise<void>;
  /** SET NX (set if not exists). Retorna true se inseriu, false se já existia. */
  setnx(key: string, value: string, exSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

// ─── Upstash HTTP adapter ────────────────────────────────────────────────────

class UpstashRedis implements RedisAdapter {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  private async command<T>(args: (string | number)[]): Promise<T> {
    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { result: T };
    return json.result;
  }

  async get(key: string): Promise<string | null> {
    return this.command<string | null>(['GET', key]);
  }

  async set(key: string, value: string, exSeconds?: number): Promise<void> {
    if (exSeconds) {
      await this.command(['SET', key, value, 'EX', exSeconds]);
    } else {
      await this.command(['SET', key, value]);
    }
  }

  async setnx(key: string, value: string, exSeconds: number): Promise<boolean> {
    const result = await this.command<string | null>(['SET', key, value, 'EX', exSeconds, 'NX']);
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.command(['DEL', key]);
  }
}

// ─── Fallback em memória (dev sem Upstash) ───────────────────────────────────

class InMemoryRedis implements RedisAdapter {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return true;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, exSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: exSeconds ? Date.now() + exSeconds * 1000 : undefined,
    });
  }

  async setnx(key: string, value: string, exSeconds: number): Promise<boolean> {
    if (!this.isExpired(key)) return false;
    await this.set(key, value, exSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ─── Exporta a instância correta ─────────────────────────────────────────────

function createRedis(): RedisAdapter {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    console.log('[redis] Usando Upstash Redis');
    return new UpstashRedis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  console.warn('[redis] ⚠️  Upstash não configurado — usando fallback em memória (não use em produção!)');
  return new InMemoryRedis();
}

export const redis = createRedis();

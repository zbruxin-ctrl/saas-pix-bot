import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(__dirname, '../../../../.env') });

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  TELEGRAM_BOT_SECRET: z.string().min(16),
  API_URL: z.string().url().default('http://localhost:3001'),
  BOT_WEBHOOK_URL: z.string().url().optional(),
  SUPPORT_PHONE: z.string().min(1, 'SUPPORT_PHONE é obrigatório'),
  // Upstash Redis — obrigatório em produção, opcional em dev (usa fallback em memória)
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Variáveis de ambiente inválidas no bot:');
    result.error.errors.forEach((e) => console.error(`   ${e.path.join('.')}: ${e.message}`));
    process.exit(1);
  }
  return result.data;
}

export const env = validateEnv();

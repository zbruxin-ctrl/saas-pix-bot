// Carrega o arquivo .env antes de qualquer validação
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(__dirname, '../../../../.env') });

// Validação das variáveis de ambiente do bot
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  TELEGRAM_BOT_SECRET: z.string().min(16),
  API_URL: z.string().url().default('http://localhost:3001'),
  // Em produção: URL pública da API (ex: https://api-production-a596.up.railway.app)
  // O bot registra o webhook no Telegram apontando para essa URL.
  // A API recebe os updates e repassa via bot.handleUpdate() — sem porta própria.
  BOT_WEBHOOK_URL: z.string().url().optional(),
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

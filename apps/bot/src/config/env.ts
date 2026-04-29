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
  // Em produção: URL pública do bot (ex: https://bot-production-301b.up.railway.app)
  // O bot registra o webhook no Telegram apontando para essa URL.
  BOT_WEBHOOK_URL: z.string().url().optional(),
  // Número de suporte no formato internacional sem espaços (ex: 5511953689608)
  // Usado no link wa.me da Central de Ajuda do bot.
  SUPPORT_PHONE: z.string().min(1, 'SUPPORT_PHONE é obrigatório'),
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

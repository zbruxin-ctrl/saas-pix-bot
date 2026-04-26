import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';

import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { paymentsRouter } from './routes/payments';
import { webhooksRouter } from './routes/webhooks';
import adminRouter from './routes/admin';
import { startExpireJob, stopExpireJob } from './jobs/expirePayments';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

// FIX S1: CORS via allowlist explícita.
// Não mais aceita qualquer *.vercel.app — apenas ADMIN_URL + origens extras declaradas em ALLOWED_ORIGINS.
// Para adicionar outro domínio (ex: Vercel preview específico), configure ALLOWED_ORIGINS no Railway:
//   ALLOWED_ORIGINS=https://meu-painel.vercel.app,https://preview-xyz.vercel.app
const extraOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  env.ADMIN_URL,
  ...(env.BOT_WEBHOOK_URL ? [env.BOT_WEBHOOK_URL] : []),
  ...(env.NODE_ENV === 'development'
    ? ['http://localhost:3000', 'http://localhost:3001']
    : []),
  ...extraOrigins,
].filter(Boolean) as string[];

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // requests sem Origin (ex: curl, Railway health checks)
  return allowedOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) callback(null, origin ?? '*');
    else callback(new Error(`CORS: origem nao permitida: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposedHeaders: ['Set-Cookie'],
}));

app.use(compression());
app.use(cookieParser(env.COOKIE_SECRET));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploads locais (fallback quando Cloudinary não está configurado)
// Em produção com Cloudinary isso não é chamado pois as URLs já são do Cloudinary
app.use('/uploads', express.static('uploads'));

// --- Rota de setup inicial ---
// FIX S3: aceita apenas POST (não GET) para evitar navegação acidental no browser.
// Uso: POST /setup-admin com body { secret, email, password }
// Remova SETUP_SECRET do Railway após usar.
app.post('/setup-admin', async (req, res) => {
  const setupSecret = process.env.SETUP_SECRET;
  if (!setupSecret) { res.status(404).json({ error: 'Rota nao disponivel' }); return; }

  const { secret, email, password } = req.body as Record<string, string>;
  if (secret !== setupSecret) { res.status(403).json({ error: 'Secret invalido' }); return; }
  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'Informe email e password (minimo 8 caracteres)' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, isActive: true },
    create: { email: email.toLowerCase(), passwordHash, name: 'Admin Principal', role: 'SUPERADMIN', isActive: true },
  });

  logger.info(`[setup-admin] Admin criado/atualizado: ${admin.email}`);
  res.json({ success: true, message: `Admin ${admin.email} pronto. Remova SETUP_SECRET do Railway agora.` });
});

app.use('/api/auth', authRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(`API rodando na porta ${env.PORT}`);
  logger.info(`Ambiente: ${env.NODE_ENV}`);
  startExpireJob();
});

async function shutdown(signal: string) {
  logger.info(`${signal} recebido. Encerrando servidor...`);
  stopExpireJob();
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;

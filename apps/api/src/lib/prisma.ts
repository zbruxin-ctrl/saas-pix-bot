import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient() {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['error', 'warn']
        : ['error'],
  });
}

export let prisma: PrismaClient =
  globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Wrapper com reconexão automática.
 * Quando o Neon/PgBouncer fecha a conexão idle (kind: Closed),
 * descarta o client atual, cria um novo e retenta a operação uma vez.
 */
export async function withReconnect<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg = String(err);
    const isConnClosed =
      msg.includes('kind: Closed') ||
      msg.includes('Server has closed the connection') ||
      msg.includes('Connection refused') ||
      msg.includes('ECONNRESET') ||
      msg.includes('P1001') || // Prisma: Can't reach database
      msg.includes('P1017');   // Prisma: Server has closed connection

    if (isConnClosed) {
      logger.warn('Prisma: conexão fechada detectada — reconectando...');

      try { await prisma.$disconnect(); } catch (_) {}

      prisma = createClient();
      if (process.env.NODE_ENV !== 'production') {
        globalForPrisma.prisma = prisma;
      }

      logger.info('Prisma: reconectado. Retentando operação...');
      return await fn(); // retenta UMA vez
    }

    throw err;
  }
}

// Garante desconexão limpa ao encerrar
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

export default prisma;

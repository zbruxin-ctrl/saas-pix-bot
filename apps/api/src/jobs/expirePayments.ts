// Job agendado: expira pagamentos pendentes há mais de 30 minutos
// Deve ser inicializado uma vez no index.ts com startExpireJob()
import { PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { paymentService } from '../services/paymentService';
import { stockService } from '../services/stockService';
import { logger } from '../lib/logger';

const JOB_INTERVAL_MS = 60 * 1000;    // roda a cada 1 minuto
const PAYMENT_TTL_MINUTES = 30;

let jobTimer: ReturnType<typeof setInterval> | null = null;

async function runExpireJob(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - PAYMENT_TTL_MINUTES * 60 * 1000);

    // Busca pagamentos pendentes que passaram do TTL
    const expiredPayments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: { id: true },
    });

    if (expiredPayments.length > 0) {
      logger.info(`[ExpireJob] ${expiredPayments.length} pagamentos a expirar`);

      await Promise.allSettled(
        expiredPayments.map((p) => paymentService.cancelExpiredPayment(p.id))
      );
    }

    // Libera reservas de estoque com expiresAt no passado
    await stockService.releaseExpiredReservations();

  } catch (err) {
    logger.error('[ExpireJob] Erro durante execução:', err);
  }
}

export function startExpireJob(): void {
  if (jobTimer) return;

  logger.info(`[ExpireJob] Iniciado — intervalo: ${JOB_INTERVAL_MS / 1000}s`);

  // Executa imediatamente na inicialização
  void runExpireJob();

  jobTimer = setInterval(() => {
    void runExpireJob();
  }, JOB_INTERVAL_MS);
}

export function stopExpireJob(): void {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
    logger.info('[ExpireJob] Parado');
  }
}

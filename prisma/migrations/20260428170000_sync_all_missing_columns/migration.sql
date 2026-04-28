-- Migration definitiva: sincroniza todas as colunas faltantes

-- payments: colunas novas
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='cancelledAt') THEN
    ALTER TABLE "payments" ADD COLUMN "cancelledAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='expiredAt') THEN
    ALTER TABLE "payments" ADD COLUMN "expiredAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='pixExpiresAt') THEN
    ALTER TABLE "payments" ADD COLUMN "pixExpiresAt" TIMESTAMP(3);
  END IF;
END $$;

-- payments: productId agora e opcional
ALTER TABLE "payments" ALTER COLUMN "productId" DROP NOT NULL;

-- orders: coluna failedAt
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='failedAt') THEN
    ALTER TABLE "orders" ADD COLUMN "failedAt" TIMESTAMP(3);
  END IF;
END $$;

-- webhook_events: coluna updatedAt
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='webhook_events' AND column_name='updatedAt') THEN
    ALTER TABLE "webhook_events" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

-- delivery_logs: coluna status como TEXT (schema usa String agora)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='delivery_logs' AND column_name='status' AND data_type='USER-DEFINED') THEN
    ALTER TABLE "delivery_logs" ALTER COLUMN "status" TYPE TEXT USING "status"::TEXT;
  END IF;
END $$;

-- Cria tabelas novas se nao existirem

-- stock_items
CREATE TABLE IF NOT EXISTS "stock_items" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "reservedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "paymentId" TEXT,
  "orderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_items_paymentId_key') THEN
    ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_paymentId_key" UNIQUE ("paymentId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_items_orderId_key') THEN
    ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_orderId_key" UNIQUE ("orderId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stock_items_productId_status_idx" ON "stock_items"("productId", "status");
CREATE INDEX IF NOT EXISTS "stock_items_productId_status_createdAt_idx" ON "stock_items"("productId", "status", "createdAt");

-- stock_reservations
CREATE TABLE IF NOT EXISTS "stock_reservations" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "telegramUserId" TEXT NOT NULL,
  "paymentId" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_paymentId_key') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_paymentId_key" UNIQUE ("paymentId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stock_reservations_productId_status_idx" ON "stock_reservations"("productId", "status");
CREATE INDEX IF NOT EXISTS "stock_reservations_expiresAt_status_idx" ON "stock_reservations"("expiresAt", "status");
CREATE INDEX IF NOT EXISTS "stock_reservations_telegramUserId_idx" ON "stock_reservations"("telegramUserId");

-- wallet_transactions
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id" TEXT NOT NULL,
  "telegramUserId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "description" TEXT NOT NULL,
  "paymentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "wallet_transactions_telegramUserId_idx" ON "wallet_transactions"("telegramUserId");
CREATE INDEX IF NOT EXISTS "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");

-- delivery_medias
CREATE TABLE IF NOT EXISTS "delivery_medias" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "caption" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_medias_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "delivery_medias_orderId_idx" ON "delivery_medias"("orderId");

-- Foreign keys novas (ignorar erro se ja existir)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_items_productId_fkey') THEN
    ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_items_paymentId_fkey') THEN
    ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_items_orderId_fkey') THEN
    ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_productId_fkey') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_telegramUserId_fkey') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_paymentId_fkey') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='wallet_transactions_telegramUserId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='delivery_medias_orderId_fkey') THEN
    ALTER TABLE "delivery_medias" ADD CONSTRAINT "delivery_medias_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Indices novos em payments
CREATE INDEX IF NOT EXISTS "payments_telegramUserId_idx" ON "payments"("telegramUserId");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");
CREATE INDEX IF NOT EXISTS "payments_mercadoPagoId_idx" ON "payments"("mercadoPagoId");

-- Indices novos em orders
CREATE INDEX IF NOT EXISTS "orders_telegramUserId_idx" ON "orders"("telegramUserId");
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders"("status");

-- Indices novos em delivery_logs
CREATE INDEX IF NOT EXISTS "delivery_logs_status_createdAt_idx" ON "delivery_logs"("status", "createdAt");

-- Indices novos em webhook_events
CREATE INDEX IF NOT EXISTS "webhook_events_status_idx" ON "webhook_events"("status");
CREATE INDEX IF NOT EXISTS "webhook_events_paymentId_idx" ON "webhook_events"("paymentId");
CREATE INDEX IF NOT EXISTS "webhook_events_createdAt_idx" ON "webhook_events"("createdAt");

-- Migration: fix_drift_and_add_stock_items
-- Sincroniza alterações que já existem no banco com o histórico de migrations
-- e adiciona a tabela stock_items para o sistema FIFO.
-- NÃO dropa nada. Seguro para banco com dados.

-- ─── 1. Enums que já existem no banco mas faltavam na migration init ──────────

DO $$ BEGIN
  CREATE TYPE "DeliveryMediaType" AS ENUM ('IMAGE', 'VIDEO', 'FILE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONFIRMED', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "DeliveryType" ADD VALUE IF NOT EXISTS 'FILE_MEDIA';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Corrige AdminRole: o init criou SUPER_ADMIN mas o schema usa SUPERADMIN
-- Renomeia o valor com segurança (PostgreSQL 15+)
DO $$ BEGIN
  ALTER TYPE "AdminRole" RENAME VALUE 'SUPER_ADMIN' TO 'SUPERADMIN';
EXCEPTION WHEN invalid_parameter_value THEN null;
END $$;

-- Corrige DeliveryType: o init criou TOKEN mas o schema usa FILE_MEDIA (já adicionado acima)
-- TOKEN pode existir no banco; não removemos para não quebrar dados existentes.

-- ─── 2. Coluna cancelledAt em payments (se não existir) ──────────────────────
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- ─── 3. Índice em payments(pixExpiresAt, status) ─────────────────────────────
CREATE INDEX IF NOT EXISTS "payments_pixExpiresAt_status_idx"
  ON "payments"("pixExpiresAt", "status");

-- ─── 4. Tabela delivery_medias (se não existir) ──────────────────────────────
CREATE TABLE IF NOT EXISTS "delivery_medias" (
  "id"        TEXT                  NOT NULL,
  "orderId"   TEXT                  NOT NULL,
  "url"       TEXT                  NOT NULL,
  "mediaType" "DeliveryMediaType"   NOT NULL,
  "caption"   TEXT,
  "sortOrder" INTEGER               NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "delivery_medias_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "delivery_medias_orderId_idx"
  ON "delivery_medias"("orderId");

DO $$ BEGIN
  ALTER TABLE "delivery_medias"
    ADD CONSTRAINT "delivery_medias_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── 5. Tabela stock_reservations (se não existir) ────────────────────────────
CREATE TABLE IF NOT EXISTS "stock_reservations" (
  "id"             TEXT                     NOT NULL,
  "productId"      TEXT                     NOT NULL,
  "telegramUserId" TEXT                     NOT NULL,
  "paymentId"      TEXT,
  "quantity"       INTEGER                  NOT NULL DEFAULT 1,
  "status"         "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt"      TIMESTAMP(3)             NOT NULL,
  "confirmedAt"    TIMESTAMP(3),
  "releasedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stock_reservations_paymentId_key"
  ON "stock_reservations"("paymentId");

CREATE INDEX IF NOT EXISTS "stock_reservations_productId_status_idx"
  ON "stock_reservations"("productId", "status");

CREATE INDEX IF NOT EXISTS "stock_reservations_expiresAt_status_idx"
  ON "stock_reservations"("expiresAt", "status");

CREATE INDEX IF NOT EXISTS "stock_reservations_telegramUserId_idx"
  ON "stock_reservations"("telegramUserId");

DO $$ BEGIN
  ALTER TABLE "stock_reservations"
    ADD CONSTRAINT "stock_reservations_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_reservations"
    ADD CONSTRAINT "stock_reservations_telegramUserId_fkey"
    FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_reservations"
    ADD CONSTRAINT "stock_reservations_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── 6. Tabela stock_items — FIFO por unidade ─────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "StockItemStatus" AS ENUM (
    'AVAILABLE', 'RESERVED', 'CONFIRMED', 'DELIVERED', 'RELEASED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "stock_items" (
  "id"          TEXT              NOT NULL,
  "productId"   TEXT              NOT NULL,
  "content"     TEXT              NOT NULL,
  "status"      "StockItemStatus" NOT NULL DEFAULT 'AVAILABLE',
  "reservedAt"  TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "releasedAt"  TIMESTAMP(3),
  "paymentId"   TEXT,
  "orderId"     TEXT,
  "createdAt"   TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stock_items_paymentId_key"
  ON "stock_items"("paymentId");

CREATE UNIQUE INDEX IF NOT EXISTS "stock_items_orderId_key"
  ON "stock_items"("orderId");

CREATE INDEX IF NOT EXISTS "stock_items_productId_status_idx"
  ON "stock_items"("productId", "status");

CREATE INDEX IF NOT EXISTS "stock_items_productId_status_createdAt_idx"
  ON "stock_items"("productId", "status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "stock_items"
    ADD CONSTRAINT "stock_items_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_items"
    ADD CONSTRAINT "stock_items_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "stock_items"
    ADD CONSTRAINT "stock_items_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

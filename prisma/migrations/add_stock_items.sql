-- Migration: adiciona tabela stock_items para FIFO por unidade
-- Execute com: npx prisma migrate dev --name add_stock_items

CREATE TYPE "StockItemStatus" AS ENUM (
  'AVAILABLE',
  'RESERVED',
  'CONFIRMED',
  'DELIVERED',
  'RELEASED'
);

CREATE TABLE "stock_items" (
  "id"           TEXT         NOT NULL,
  "productId"    TEXT         NOT NULL,
  "content"      TEXT         NOT NULL,
  "status"       "StockItemStatus" NOT NULL DEFAULT 'AVAILABLE',
  "reservedAt"   TIMESTAMP(3),
  "confirmedAt"  TIMESTAMP(3),
  "deliveredAt"  TIMESTAMP(3),
  "releasedAt"   TIMESTAMP(3),
  "paymentId"    TEXT,
  "orderId"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_items_paymentId_key" ON "stock_items"("paymentId");
CREATE UNIQUE INDEX "stock_items_orderId_key" ON "stock_items"("orderId");
CREATE INDEX "stock_items_productId_status_idx" ON "stock_items"("productId", "status");
CREATE INDEX "stock_items_productId_status_createdAt_idx" ON "stock_items"("productId", "status", "createdAt");

ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Adiciona coluna OrderStatus CANCELLED se não existir
DO $$ BEGIN
  ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

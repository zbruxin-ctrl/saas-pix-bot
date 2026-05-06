-- FEAT-QTY: suporte a compra de múltiplas unidades
-- 1. Adiciona coluna qty em payments
-- 2. Remove constraint unique de orders.paymentId
-- 3. Remove constraint unique de stock_items.paymentId e cria index simples

-- 1. Coluna qty no Payment
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "qty" INTEGER NOT NULL DEFAULT 1;

-- 2. Remove unique de orders.paymentId e cria index simples
-- (o nome da constraint pode variar; usamos IF EXISTS para segurança)
DO $$
BEGIN
  -- tenta remover a constraint unique pelo nome padrão do Prisma
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_paymentId_key'
      AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE "orders" DROP CONSTRAINT "orders_paymentId_key";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "orders_paymentId_idx" ON "orders"("paymentId");

-- 3. Remove unique de stock_items.paymentId e cria index simples
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_items_paymentId_key'
      AND conrelid = 'stock_items'::regclass
  ) THEN
    ALTER TABLE "stock_items" DROP CONSTRAINT "stock_items_paymentId_key";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stock_items_paymentId_idx" ON "stock_items"("paymentId");

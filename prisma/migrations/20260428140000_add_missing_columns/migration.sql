-- Migration: add_missing_columns
-- Adiciona sortOrder em products (se nao existir)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='products' AND column_name='sort_order'
  ) THEN
    ALTER TABLE "products" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Cria enum WebhookEventStatus (se nao existir)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookEventStatus') THEN
    CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');
  END IF;
END $$;

-- Altera coluna status da tabela webhook_events para usar o enum (se for text)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='webhook_events' AND column_name='status' AND data_type='text'
  ) THEN
    ALTER TABLE "webhook_events"
      ALTER COLUMN "status" TYPE "WebhookEventStatus"
      USING "status"::"WebhookEventStatus";
  END IF;
END $$;

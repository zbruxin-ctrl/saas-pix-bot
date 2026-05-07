-- FIX-BOT-SOURCE: adiciona coluna bot_source ao model Payment
-- Valores possíveis: 'telegram' | 'whatsapp' | NULL (retrocompatível: NULL = telegram)
ALTER TABLE "payments" ADD COLUMN "botSource" TEXT;

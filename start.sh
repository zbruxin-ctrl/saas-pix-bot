#!/bin/sh
set -e

echo '>>> [1/4] Resolvendo migrations com falha (se houver)'
npx prisma migrate resolve \
  --schema=./prisma/schema.prisma \
  --rolled-back 20260428140000_add_missing_columns 2>/dev/null || true

echo '>>> [2/4] Rodando migrations'
npx prisma migrate deploy --schema=./prisma/schema.prisma
echo '>>> [3/4] Migrations OK'

echo '>>> [4/4] Iniciando node'
exec node apps/api/dist/index.js

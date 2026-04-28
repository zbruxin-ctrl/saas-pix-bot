#!/bin/sh
set -e

echo '=== [1/3] Migrations ==='
npx prisma migrate deploy --schema=./prisma/schema.prisma
echo '=== Migrations OK ==='

echo '=== [2/3] Verificando modulos ==='
node -e "require('@prisma/client'); console.log('Prisma client OK')" || echo 'AVISO: Prisma client com problema'
node -e "require('./apps/api/dist/index.js')" 2>&1 | head -5 &
PID=$!
sleep 3
if kill -0 $PID 2>/dev/null; then
  echo 'AVISO: processo iniciou mas ainda rodando em background (pode ser normal)'
fi

echo '=== [3/3] Iniciando API ==='
exec node apps/api/dist/index.js

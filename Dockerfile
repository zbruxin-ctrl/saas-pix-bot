FROM node:20-alpine

# ✅ Corrige Prisma: instala OpenSSL 1.1.x compatível
RUN apk add --no-cache openssl1.1-compat

WORKDIR /app

# Copia package files (cache npm layers)
COPY package*.json ./
COPY packages/*/package*.json ./packages/
COPY apps/*/package*.json ./apps/
RUN npm ci --only=production --no-optional

# Copia código
COPY packages ./packages
COPY apps ./apps
COPY prisma ./prisma
COPY tsconfig.json ./

# ✅ Gera Prisma client APÓS OpenSSL
RUN npx prisma generate --schema=./prisma/schema.prisma

# Build
RUN npm run build -w packages/shared
RUN npm run build -w apps/api
RUN npm run build -w apps/bot

EXPOSE 3001 8080
CMD ["node", "apps/api/dist/index.js"]

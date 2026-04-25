FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
COPY packages/*/package*.json ./packages/
COPY apps/*/package*.json ./apps/
RUN npm install
COPY packages ./packages
COPY apps ./apps
COPY prisma ./prisma
COPY tsconfig.json ./
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npm run build -w packages/shared
RUN npm run build -w apps/api
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# --- Production image ---
FROM node:20-alpine AS runner

RUN addgroup -S botgroup && adduser -S botuser -G botgroup

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY src/db/schema.sql ./dist/db/schema.sql

RUN mkdir -p /app/data && chown botuser:botgroup /app/data

USER botuser

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/bot.db

EXPOSE 3000

CMD ["node", "dist/index.js"]

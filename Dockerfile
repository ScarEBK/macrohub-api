# Stage 1: Builder
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Stage 2: Runner
FROM node:22-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY drizzle.config.ts ./
COPY src/db ./src/db

ENV NODE_ENV=production

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "npx drizzle-kit push && node dist/index.js"]
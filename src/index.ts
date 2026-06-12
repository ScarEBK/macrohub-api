import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema.js';
import { runMigrations } from './db/migrate.js';

import authRoutes from './routes/auth.js';
import licenseRoutes from './routes/licenses.js';
import trialRoutes from './routes/trials.js';
import referralRoutes from './routes/referrals.js';
import sellauthRoutes from './routes/sellauth.js';
import announcementRoutes from './routes/announcements.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import migrationRoutes from './routes/migration.js';

// ── Database connection with retry ──────────────────────────────────────────
async function connectDatabase(dbUrl: string, maxRetries = 5): Promise<ReturnType<typeof postgres>> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = postgres(dbUrl);
      // Verify connection with a simple query
      await client`SELECT 1`;
      console.log(`[db] Connected on attempt ${attempt}`);
      return client;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[db] Connection attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`[db] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${lastError?.message}`);
}

const dbUrl = process.env.DATABASE_URL!;
const client = await connectDatabase(dbUrl);
const db = drizzle(client, { schema });

// ── Run idempotent schema migrations ────────────────────────────────────────
await runMigrations(dbUrl);

const app = Fastify({ logger: true });

// ── CORS ────────────────────────────────────────────────────────────────────
await app.register(cors, { origin: true });

// ── Rate limiting ───────────────────────────────────────────────────────────
await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// ── Decorate with db ────────────────────────────────────────────────────────
app.decorate('db', db);

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', async () => ({
  ok: true,
  timestamp: new Date().toISOString(),
}));

// ── Route registration ──────────────────────────────────────────────────────
await app.register(authRoutes);
await app.register(licenseRoutes);
await app.register(trialRoutes);
await app.register(referralRoutes);
await app.register(sellauthRoutes);
await app.register(announcementRoutes);
await app.register(reportRoutes, {
  prefix: '/reports',
});
await app.register(adminRoutes);
await app.register(migrationRoutes);

// ── Start server ────────────────────────────────────────────────────────────
const port = Number(process.env.PORT) || 3001;

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down gracefully`);
  await app.close();
  await client.end();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
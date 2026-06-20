import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema.js';
import { runMigrations } from './db/migrate.js';
import { ensureSchema } from './db/ensure-schema.js';
import { timingSafeEqual } from './lib/crypto.js';

import authRoutes from './routes/auth.js';
import licenseRoutes from './routes/licenses.js';
import trialRoutes from './routes/trials.js';
import referralRoutes from './routes/referrals.js';
import sellauthRoutes from './routes/sellauth.js';
import announcementRoutes from './routes/announcements.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import migrationRoutes from './routes/migration.js';
import importSnapshotRoutes from './routes/import-snapshot.js';

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

// ── Create tables if missing, then run column migrations ───────────────────
await ensureSchema(dbUrl);
await runMigrations(dbUrl);

const app = Fastify({ logger: true });

// ── Raw-body capture for the SellAuth webhook ──────────────────────────────
// The webhook HMAC signature is computed over the raw request bytes. Fastify's
// default JSON parser converts the body to an object, losing the original bytes.
// This content-type parser captures the raw string AND stores it on request.rawBody
// so the webhook route can verify the HMAC over the exact bytes SellAuth signed.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const raw = body as string;
    (req as any).rawBody = raw;
    const parsed = JSON.parse(raw);
    done(null, parsed);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// ── Global error handler — never leak internal error details to clients ────
// Without this, uncaught errors (DB connection lost, unexpected throws) produce
// Fastify's default 500 with the raw err.message in the body, which the desktop's
// parseRestError pipes straight to users. This handler logs the real error
// server-side and returns a clean message.
app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
  request.log.error({ err }, 'Unhandled error');
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;
  reply.code(status).send({
    error: status >= 500
      ? 'Something went wrong on our end. Please try again in a moment.'
      : err.message,
  });
});

// ── CORS — restrict to known origins (desktop static server + dev) ─────────
// The desktop app loads from http://127.0.0.1:47891 (packaged) or file://.
// The API is not meant to be called from arbitrary websites.
await app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no Origin header (desktop app, curl, etc.)
    if (!origin) return cb(null, true);
    const allowed = [
      'http://127.0.0.1:47891',
      'http://localhost:47891',
      'http://localhost:5173',
    ];
    if (allowed.includes(origin)) return cb(null, true);
    return cb(null, false); // reject unknown origins
  },
});

// ── Rate limiting ───────────────────────────────────────────────────────────
await app.register(rateLimit, {
  // Raised from 5000 to 20000/min. The Railway proxy pools all client
  // traffic through a small set of egress IPs, so the IP-keyed bucket is
  // shared across many users. 5000/min was tight even for legitimate polling
  // (every desktop checks /licenses/access every 3 min + on events), and once
  // the B1 fix made the access check actually reach the server, a burst of
  // simultaneous client updates could trip the limiter and 429 legitimate
  // redeems. 20000/min gives comfortable headroom while still blocking abuse.
  max: 20000,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    // M-7 fix (audit 2026-06-19): previously any non-empty x-admin-secret
    // header (even a wrong one) yielded a private admin:<ip> bucket, giving
    // an attacker a dedicated 20k/min bucket separate from the shared IP
    // pool. Now only verified admin requests get the private bucket —
    // verify the secret with a timing-safe compare before keying. A wrong
    // secret falls through to the shared IP bucket (the adminAuth preHandler
    // will still 401 it downstream).
    const provided = request.headers['x-admin-secret'];
    const expected = process.env.ADMIN_SECRET || process.env.CONVEX_ADMIN_SECRET;
    if (typeof provided === 'string' && typeof expected === 'string' && expected.length > 0) {
      // Cheap length gate then constant-time compare. Both sides are
      // app-controlled lengths so the length gate doesn't leak timing.
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        return `admin:${request.ip}`;
      }
    }
    return request.ip;
  },
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
// NOTE: reportRoutes defines its own /reports/submit + /reports/recent paths.
// Do NOT prefix — otherwise the effective route becomes /reports/reports/submit (404).
await app.register(reportRoutes);
await app.register(adminRoutes);
await app.register(importSnapshotRoutes);
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
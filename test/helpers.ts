import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify from 'fastify';
import * as schema from '../src/db/schema.js';
import { INIT_SQL } from '../src/db/ensure-schema.js';
import { MIGRATIONS } from '../src/db/migrate.js';
import { users, desktopSessions, licenseKeys } from '../src/db/schema.js';

// auth.ts reads MOTIONCORD_DESKTOP_SECRET at module load time, so these must
// be set before any test dynamically imports the route plugins.
process.env.MOTIONCORD_DESKTOP_SECRET ||= 'test-motioncord-secret';
process.env.ADMIN_SECRET ||= 'test-admin-secret';
process.env.SELLAUTH_WEBHOOK_SECRET ||= 'test-webhook-secret';

export async function createTestDb() {
  const client = new PGlite();

  // Bootstrap the same tables prod creates on first deploy.
  await client.exec(INIT_SQL);

  // Apply the column migrations the same way migrate.ts does: run each
  // statement, ignore "already exists"/"does not exist"/duplicate errors —
  // identical to the ignore logic in runMigrations().
  for (const mig of MIGRATIONS) {
    try {
      await client.exec(mig.sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|does not exist|duplicate/i.test(msg)) {
        throw err;
      }
    }
  }

  const db = drizzle(client, { schema });
  return { client, db };
}

export async function buildTestApp() {
  const { db } = await createTestDb();

  const app = Fastify({ logger: false });
  app.decorate('db', db as any);

  const { default: authRoutes } = await import('../src/routes/auth.js');
  const { default: licenseRoutes } = await import('../src/routes/licenses.js');
  const { default: sellauthRoutes } = await import('../src/routes/sellauth.js');
  await app.register(authRoutes);
  await app.register(licenseRoutes);
  await app.register(sellauthRoutes);
  await app.ready();

  return app;
}

export async function insertUser(
  db: any,
  discordId: string,
  hwid: string,
  extra: Partial<typeof users.$inferInsert> = {},
) {
  const [row] = await db
    .insert(users)
    .values({
      discordId,
      username: `user-${discordId}`,
      hwid,
      ...extra,
    })
    .returning();
  return row;
}

export async function insertSession(db: any, discordId: string, hwid: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(desktopSessions).values({
    discordId,
    token,
    hwid,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return token;
}

export async function insertKey(
  db: any,
  opts: { macro: string; duration: string; status?: string },
) {
  const key = crypto.randomBytes(8).toString('hex').toUpperCase();
  const [row] = await db
    .insert(licenseKeys)
    .values({
      key,
      macro: opts.macro,
      duration: opts.duration,
      status: opts.status ?? 'available',
    })
    .returning();
  return row;
}

/** POST a signed store delivery, exactly as SellAuth / motionlifeshop.com send it. */
export async function deliver(app: any, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', process.env.SELLAUTH_WEBHOOK_SECRET as string)
    .update(body)
    .digest('hex');
  return app.inject({
    method: 'POST',
    url: '/sellauth/webhook',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    payload: body,
  });
}

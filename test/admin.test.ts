import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { buildTestApp, insertUser } from './helpers.js';
import { userMacros } from '../src/db/schema.js';

const ADMIN_SECRET = process.env.ADMIN_SECRET as string;

async function addTime(app: any, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/licenses/add-time',
    headers: { 'x-admin-secret': ADMIN_SECRET },
    payload: body,
  });
}

describe('POST /licenses/add-time', () => {
  let app: any;
  let db: any;
  const discordId = 'admin-add-time-user';
  const macro = 'Speed Boost';

  beforeEach(async () => {
    app = await buildTestApp();
    db = app.db;
    await insertUser(db, discordId, 'hwid-admin-add-time');
    await db.insert(userMacros).values({
      discordId,
      macro,
      status: 'active',
      source: 'manual',
      duration: '7d',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  it('rejects negative days with 400', async () => {
    const r = await addTime(app, { discordId, macro, days: -5 });
    expect(r.statusCode).toBe(400);
  });

  it('rejects out-of-range days (99999) with 400', async () => {
    const r = await addTime(app, { discordId, macro, days: 99999 });
    expect(r.statusCode).toBe(400);
  });

  it('accepts valid days (7) with 200', async () => {
    const r = await addTime(app, { discordId, macro, days: 7 });
    expect(r.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(userMacros)
      .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, macro)));
    expect(row.status).toBe('active');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { buildTestApp, insertUser, insertSession, insertKey } from './helpers.js';
import { userMacros, adminLogs, licenseKeys } from '../src/db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 60 * 1000; // ±1 min

function expectCloseTo(actual: number, expected: number, tolerance = TOLERANCE_MS) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

async function redeem(app: any, token: string, hwid: string, key: string) {
  return app.inject({
    method: 'POST',
    url: '/licenses/redeem',
    headers: { 'x-session-token': token, 'x-hwid': hwid },
    payload: { key },
  });
}

describe('POST /licenses/redeem', () => {
  let app: any;
  let db: any;

  beforeEach(async () => {
    app = await buildTestApp();
    db = app.db;
  });

  it('1. parallel redeem of the same key by 5 different users: exactly 1x200 and 4x409', async () => {
    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });

    const sessions = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const discordId = `user-parallel-${i}`;
        const hwid = `hwid-parallel-${i}`;
        await insertUser(db, discordId, hwid);
        const token = await insertSession(db, discordId, hwid);
        return { token, hwid };
      }),
    );

    // NOTE: PGlite is a single-connection embedded Postgres — statements from
    // these "parallel" requests are still serialized one at a time under the
    // hood, so this does NOT exercise real row-lock contention. What it does
    // prove is that the guarded `UPDATE ... WHERE status NOT IN (...)
    // RETURNING` claim logic in the route correctly lets only one caller win
    // even when N callers all see status='available' before any of them writes.
    const responses = await Promise.all(
      sessions.map((s) => redeem(app, s.token, s.hwid, key.key)),
    );

    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);

    const conflicts = responses.filter((r) => r.statusCode === 409);
    for (const c of conflicts) {
      expect(c.json()).toEqual({ error: 'KEY_ALREADY_REDEEMED' });
    }

    const rows = await db.select().from(userMacros).where(eq(userMacros.licenseKeyId, key.id));
    expect(rows.length).toBe(1);
  });

  it('2. same key redeemed twice sequentially by the same user: 200 then 409', async () => {
    const discordId = 'user-seq';
    const hwid = 'hwid-seq';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);
    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });

    const first = await redeem(app, token, hwid, key.key);
    expect(first.statusCode).toBe(200);

    const second = await redeem(app, token, hwid, key.key);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'KEY_ALREADY_REDEEMED' });
  });

  it('3. two 7d keys, same macro, same user, sequential: expiresAt ≈ now + 14d', async () => {
    const discordId = 'user-stack';
    const hwid = 'hwid-stack';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);
    const key1 = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });
    const key2 = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });

    const r1 = await redeem(app, token, hwid, key1.key);
    expect(r1.statusCode).toBe(200);

    const r2 = await redeem(app, token, hwid, key2.key);
    expect(r2.statusCode).toBe(200);

    const body2 = r2.json();
    expectCloseTo(body2.expiresAt, Date.now() + 14 * DAY_MS);
  });

  it('4. stacking on active: active Speed Boost expiring in 3d, redeem 7d => ≈ +10d from now', async () => {
    const discordId = 'user-active-stack';
    const hwid = 'hwid-active-stack';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const existingExpiresAt = new Date(Date.now() + 3 * DAY_MS);
    await db.insert(userMacros).values({
      discordId,
      macro: 'Speed Boost',
      status: 'active',
      source: 'manual',
      duration: '3d',
      expiresAt: existingExpiresAt,
    });

    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });
    const r = await redeem(app, token, hwid, key.key);
    expect(r.statusCode).toBe(200);
    expectCloseTo(r.json().expiresAt, Date.now() + 10 * DAY_MS);
  });

  it('5. revoked row: redeem 7d => status active, expiresAt ≈ now+7d (no leftover), logs reactivation', async () => {
    const discordId = 'user-revoked';
    const hwid = 'hwid-revoked';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    // Leftover time from before the revoke — must NOT be stacked onto the
    // fresh redeem.
    const staleExpiresAt = new Date(Date.now() + 30 * DAY_MS);
    await db.insert(userMacros).values({
      discordId,
      macro: 'Speed Boost',
      status: 'revoked',
      source: 'redeem',
      duration: 'lifetime',
      expiresAt: staleExpiresAt,
    });

    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });
    const r = await redeem(app, token, hwid, key.key);
    expect(r.statusCode).toBe(200);
    expectCloseTo(r.json().expiresAt, Date.now() + 7 * DAY_MS);

    const [macroRow] = await db
      .select()
      .from(userMacros)
      .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, 'Speed Boost')));
    expect(macroRow.status).toBe('active');

    const logs = await db
      .select()
      .from(adminLogs)
      .where(eq(adminLogs.action, 'license_redeem_reactivated_revoked'));
    expect(logs.length).toBe(1);
  });

  it('6. lifetime owner redeeming a 7d key stays lifetime (bug fix)', async () => {
    const discordId = 'user-lifetime';
    const hwid = 'hwid-lifetime';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    await db.insert(userMacros).values({
      discordId,
      macro: 'Speed Boost',
      status: 'active',
      source: 'redeem',
      duration: 'lifetime',
      expiresAt: null,
    });

    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });
    const r = await redeem(app, token, hwid, key.key);
    expect(r.statusCode).toBe(200);
    expect(r.json().expiresAt).toBeNull();

    const [macroRow] = await db
      .select()
      .from(userMacros)
      .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, 'Speed Boost')));
    expect(macroRow.status).toBe('active');
    expect(macroRow.expiresAt).toBeNull();

    const [keyRow] = await db.select().from(licenseKeys).where(eq(licenseKeys.id, key.id));
    expect(keyRow.status).toBe('redeemed');
  });

  it('7a. banned key => 403', async () => {
    const discordId = 'user-banned-key';
    const hwid = 'hwid-banned-key';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);
    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d', status: 'banned' });

    const r = await redeem(app, token, hwid, key.key);
    expect(r.statusCode).toBe(403);
  });

  it('7b. account banned from macro => 403 ACCOUNT_BANNED_FROM_MACRO', async () => {
    const discordId = 'user-banned-account';
    const hwid = 'hwid-banned-account';
    await insertUser(db, discordId, hwid, { bannedMacros: ['Speed Boost'] });
    const token = await insertSession(db, discordId, hwid);
    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });

    const r = await redeem(app, token, hwid, key.key);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/^ACCOUNT_BANNED_FROM_MACRO/);
  });

  it('8a. unknown key => 404 KEY_NOT_FOUND', async () => {
    const discordId = 'user-unknown-key';
    const hwid = 'hwid-unknown-key';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const r = await redeem(app, token, hwid, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'KEY_NOT_FOUND' });
  });

  it('8b. missing key => 400', async () => {
    const discordId = 'user-missing-key';
    const hwid = 'hwid-missing-key';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const r = await app.inject({
      method: 'POST',
      url: '/licenses/redeem',
      headers: { 'x-session-token': token, 'x-hwid': hwid },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('9. redeem response shape is unchanged', async () => {
    const discordId = 'user-shape';
    const hwid = 'hwid-shape';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);
    const key = await insertKey(db, { macro: 'Speed Boost', duration: '7d' });

    const r = await redeem(app, token, hwid, key.key);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toEqual({
      success: true,
      macro: 'Speed Boost',
      duration: '7d',
      expiresAt: expect.any(Number),
    });
  });
});

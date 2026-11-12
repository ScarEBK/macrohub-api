import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { buildTestApp, insertUser, insertSession, insertKey } from './helpers.js';
import { userMacros, users } from '../src/db/schema.js';

const ADMIN_SECRET = process.env.ADMIN_SECRET as string;

async function redeem(app: any, token: string, hwid: string, key: string) {
  return app.inject({
    method: 'POST',
    url: '/licenses/redeem',
    headers: { 'x-session-token': token, 'x-hwid': hwid },
    payload: { key },
  });
}

async function ban(app: any, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/licenses/ban',
    headers: { 'x-admin-secret': ADMIN_SECRET },
    payload: body,
  });
}

async function macroRow(db: any, discordId: string, macro: string) {
  const [row] = await db
    .select()
    .from(userMacros)
    .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, macro)));
  return row;
}

describe('POST /licenses/ban — refund vs account ban', () => {
  let app: any;
  let db: any;

  beforeEach(async () => {
    app = await buildTestApp();
    db = app.db;
  });

  it('17. a plain key ban (store refund) revokes that key but the buyer can still buy again', async () => {
    const discordId = 'refund-user-17';
    const hwid = 'hwid-refund-17';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const refunded = await insertKey(db, { macro: 'Strafe', duration: '7d' });
    expect((await redeem(app, token, hwid, refunded.key)).statusCode).toBe(200);

    expect((await ban(app, { key: refunded.key })).statusCode).toBe(200);
    expect((await macroRow(db, discordId, 'Strafe')).status).toBe('revoked');

    const [user] = await db.select().from(users).where(eq(users.discordId, discordId));
    expect(user.bannedMacros).toEqual([]);

    const fresh = await insertKey(db, { macro: 'Strafe', duration: '7d' });
    const again = await redeem(app, token, hwid, fresh.key);
    expect(again.statusCode).toBe(200);
    expect((await macroRow(db, discordId, 'Strafe')).status).toBe('active');
  });

  it('18. an account ban (accountBan: true) still blocks new keys for that macro', async () => {
    const discordId = 'ban-user-18';
    const hwid = 'hwid-ban-18';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const key = await insertKey(db, { macro: 'Strafe', duration: '7d' });
    expect((await redeem(app, token, hwid, key.key)).statusCode).toBe(200);
    expect((await ban(app, { key: key.key, accountBan: true })).statusCode).toBe(200);

    const fresh = await insertKey(db, { macro: 'Strafe', duration: '7d' });
    const again = await redeem(app, token, hwid, fresh.key);
    expect(again.statusCode).toBe(403);
    expect(again.json().error).toMatch(/^ACCOUNT_BANNED_FROM_MACRO/);
  });

  it('19. refunding a timed key redeemed on top of a lifetime leaves the lifetime alone', async () => {
    const discordId = 'refund-user-19';
    const hwid = 'hwid-refund-19';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const lifetime = await insertKey(db, { macro: 'Glitch Roll', duration: 'lifetime' });
    expect((await redeem(app, token, hwid, lifetime.key)).statusCode).toBe(200);
    const week = await insertKey(db, { macro: 'Glitch Roll', duration: '7d' });
    expect((await redeem(app, token, hwid, week.key)).statusCode).toBe(200);

    expect((await ban(app, { key: week.key })).statusCode).toBe(200);

    const row = await macroRow(db, discordId, 'Glitch Roll');
    expect(row.status).toBe('active');
    expect(row.expiresAt).toBeNull();
  });

  it('19b. refunding one of two lifetime keys keeps the access the other one paid for', async () => {
    const discordId = 'refund-user-19b';
    const hwid = 'hwid-refund-19b';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const first = await insertKey(db, { macro: 'Speed Boost', duration: 'lifetime' });
    expect((await redeem(app, token, hwid, first.key)).statusCode).toBe(200);
    const second = await insertKey(db, { macro: 'Speed Boost', duration: 'lifetime' });
    expect((await redeem(app, token, hwid, second.key)).statusCode).toBe(200);

    // Refund the first purchase: the second lifetime still pays for access.
    expect((await ban(app, { key: first.key })).statusCode).toBe(200);
    let row = await macroRow(db, discordId, 'Speed Boost');
    expect(row.status).toBe('active');
    expect(row.expiresAt).toBeNull();

    // Refund the second one too: now nothing pays for it.
    expect((await ban(app, { key: second.key })).statusCode).toBe(200);
    row = await macroRow(db, discordId, 'Speed Boost');
    expect(row.status).toBe('revoked');
  });

  it('19c. an account ban revokes even when another lifetime key exists', async () => {
    const discordId = 'refund-user-19c';
    const hwid = 'hwid-refund-19c';
    await insertUser(db, discordId, hwid);
    const token = await insertSession(db, discordId, hwid);

    const first = await insertKey(db, { macro: 'Strafe', duration: 'lifetime' });
    expect((await redeem(app, token, hwid, first.key)).statusCode).toBe(200);
    const second = await insertKey(db, { macro: 'Strafe', duration: 'lifetime' });
    expect((await redeem(app, token, hwid, second.key)).statusCode).toBe(200);

    expect((await ban(app, { key: first.key, accountBan: true })).statusCode).toBe(200);
    expect((await macroRow(db, discordId, 'Strafe')).status).toBe('revoked');
  });
});

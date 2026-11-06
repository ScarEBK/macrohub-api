import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestApp, insertUser, insertKey } from './helpers.js';
import { users, userMacros, licenseKeys, desktopSessions } from '../src/db/schema.js';

const H = { 'x-admin-secret': process.env.ADMIN_SECRET ?? 'test-admin-secret' };
const post = (app: any, url: string, payload: unknown, headers: any = H) =>
  app.inject({ method: 'POST', url, headers, payload });

async function redeemedKey(db: any, discordId: string, hwid: string | null, expiresAt: Date | null) {
  await insertUser(db, discordId, hwid as any);
  const k = await insertKey(db, { macro: 'Speed Boost', duration: '7d', status: 'redeemed' });
  await db.update(licenseKeys).set({ redeemedBy: discordId, redeemedAt: new Date() }).where(eq(licenseKeys.id, k.id));
  await db.insert(userMacros).values({
    discordId, macro: 'Speed Boost', status: 'active', source: 'key', duration: '7d', expiresAt, licenseKeyId: k.id,
  });
  return k;
}

describe('shop self-service endpoints', () => {
  let app: any;
  let db: any;
  // One in-memory DB for the file: every test uses its own keys/users.
  beforeAll(async () => {
    app = await buildTestApp();
    db = app.db;
  }, 600_000);

  describe('POST /licenses/lookup', () => {
    it('requires the admin secret', async () => {
      const r = await post(app, '/licenses/lookup', { key: 'x' }, {});
      expect(r.statusCode).toBeGreaterThanOrEqual(401);
    });
    it('unredeemed key', async () => {
      const k = await insertKey(db, { macro: 'Strafe', duration: 'lifetime' });
      const r = await post(app, '/licenses/lookup', { key: k.key });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        found: true, status: 'available', macro: 'Strafe', duration: 'lifetime',
        redeemed: false, hwidBound: false, expiresAt: null,
      });
    });
    it('redeemed key with HWID: exposes no ids', async () => {
      const exp = new Date(Date.now() + 86400000);
      const k = await redeemedKey(db, 'disc-lookup', 'secret-hwid-123', exp);
      const r = await post(app, '/licenses/lookup', { key: k.key });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        found: true, status: 'redeemed', macro: 'Speed Boost', duration: '7d',
        redeemed: true, hwidBound: true, expiresAt: exp.toISOString(),
      });
      expect(r.body).not.toContain('disc-lookup');
      expect(r.body).not.toContain('secret-hwid-123');
    });
    it('redeemed key without HWID', async () => {
      const k = await redeemedKey(db, 'disc-nohwid', null, null);
      const r = await post(app, '/licenses/lookup', { key: k.key });
      expect(r.json().hwidBound).toBe(false);
    });
    it('unknown key 404, bad body 400, overlong 400', async () => {
      const r = await post(app, '/licenses/lookup', { key: 'NOPE-NOPE' });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ found: false });
      expect((await post(app, '/licenses/lookup', {})).statusCode).toBe(400);
      expect((await post(app, '/licenses/lookup', { key: 'a'.repeat(201) })).statusCode).toBe(400);
    });
  });

  describe('POST /licenses/reset-hwid-by-key', () => {
    it('clears the redeemer HWID and sessions', async () => {
      const k = await redeemedKey(db, 'disc-reset', 'hw-1', null);
      await db.insert(desktopSessions).values({
        discordId: 'disc-reset', token: 'tok', hwid: 'hw-1', expiresAt: new Date(Date.now() + 1e6),
      });
      const r = await post(app, '/licenses/reset-hwid-by-key', { key: k.key });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
      const [u] = await db.select().from(users).where(eq(users.discordId, 'disc-reset'));
      expect(u.hwid).toBeNull();
      expect(u.hwidResetAllowed).toBe(true);
      expect(await db.select().from(desktopSessions).where(eq(desktopSessions.discordId, 'disc-reset'))).toHaveLength(0);
    });
    it('unknown 404 NOT_FOUND', async () => {
      const r = await post(app, '/licenses/reset-hwid-by-key', { key: 'NOPE' });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'NOT_FOUND' });
    });
    it('not redeemed 409 NOT_REDEEMED', async () => {
      const k = await insertKey(db, { macro: 'Strafe', duration: '1d' });
      const r = await post(app, '/licenses/reset-hwid-by-key', { key: k.key });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'NOT_REDEEMED' });
    });
    it('bad body 400', async () => {
      expect((await post(app, '/licenses/reset-hwid-by-key', { key: 5 })).statusCode).toBe(400);
    });
  });

  describe('POST /licenses/regenerate', () => {
    it('bans the old key and mints a same-macro/duration key', async () => {
      const old = await insertKey(db, { macro: 'Glitch Roll', duration: '30d' });
      const r = await post(app, '/licenses/regenerate', { key: old.key });
      expect(r.statusCode).toBe(200);
      const { ok, key } = r.json();
      expect(ok).toBe(true);
      expect(key).not.toBe(old.key);
      const [o] = await db.select().from(licenseKeys).where(eq(licenseKeys.id, old.id));
      expect(o.status).toBe('banned');
      const [n] = await db.select().from(licenseKeys).where(eq(licenseKeys.key, key));
      expect(n).toMatchObject({ status: 'available', macro: 'Glitch Roll', duration: '30d', redeemedBy: null });
    });
    it('parallel calls mint exactly one new key', async () => {
      const old = await insertKey(db, { macro: 'Strafe', duration: '7d' });
      const rs = await Promise.all(Array.from({ length: 4 }, () => post(app, '/licenses/regenerate', { key: old.key })));
      expect(rs.map((r: any) => r.statusCode).sort()).toEqual([200, 409, 409, 409]);
      expect(await db.select().from(licenseKeys).where(eq(licenseKeys.macro, 'Strafe')).then((r: any[]) => r.filter((x) => x.duration === '7d' && x.redeemedBy === null))).toHaveLength(2);
    });
    it('refuses redeemed 409 ALREADY_REDEEMED', async () => {
      const k = await redeemedKey(db, 'disc-regen', 'h', null);
      const r = await post(app, '/licenses/regenerate', { key: k.key });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'ALREADY_REDEEMED' });
    });
    it('refuses banned 409 REVOKED', async () => {
      const k = await insertKey(db, { macro: 'Strafe', duration: '1d', status: 'banned' });
      const r = await post(app, '/licenses/regenerate', { key: k.key });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'REVOKED' });
    });
    it('unknown 404, bad body 400', async () => {
      expect((await post(app, '/licenses/regenerate', { key: 'NOPE' })).statusCode).toBe(404);
      expect((await post(app, '/licenses/regenerate', {})).statusCode).toBe(400);
    });
  });
});

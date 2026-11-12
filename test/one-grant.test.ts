import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildTestApp, deliver } from './helpers.js';
import { userMacros, licenseKeys } from '../src/db/schema.js';

// One store purchase must pay out exactly once, whether the buyer redeems the
// delivered key, gets the purchase on first sign-in, or both.

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_SECRET = process.env.ADMIN_SECRET as string;
const WEEK = { product_id: 112404, variant_id: 929412 }; // Speed Boost 7d
const BUNDLE = { product_id: 770856, variant_id: 1286386 };

async function signIn(app: any, discordId: string, hwid: string) {
  const issuedAt = Date.now();
  const oauthProof = crypto
    .createHmac('sha256', process.env.MOTIONCORD_DESKTOP_SECRET as string)
    .update(`${discordId}:${issuedAt}`)
    .digest('hex');
  const r = await app.inject({
    method: 'POST',
    url: '/auth/oauth',
    payload: { discordId, username: 'whatever', hwid, oauthProof, issuedAt },
  });
  expect(r.statusCode).toBe(200);
  return r.json().sessionToken as string;
}

async function redeem(app: any, token: string, hwid: string, key: string) {
  return app.inject({
    method: 'POST',
    url: '/licenses/redeem',
    headers: { 'x-session-token': token, 'x-hwid': hwid },
    payload: { key },
  });
}

async function daysLeft(db: any, discordId: string) {
  const rows = await db.select().from(userMacros).where(eq(userMacros.discordId, discordId));
  return rows.map((r: any) =>
    r.status !== 'active' ? r.status : r.expiresAt ? Math.round((+new Date(r.expiresAt) - Date.now()) / DAY_MS) : 'lifetime',
  );
}

describe('one store purchase = one grant', () => {
  let app: any;
  let db: any;

  beforeEach(async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    app = await buildTestApp();
    db = app.db;
  });

  it('20. sign-in pays the order out, then the same order key cannot be redeemed again', async () => {
    const d = await deliver(app, { order_id: 'G20-1-1', ...WEEK, custom_fields: { discord_id: '200000000000000020' } });
    const key = d.body.trim();
    const token = await signIn(app, '200000000000000020', 'HWID-G20');
    expect(await daysLeft(db, '200000000000000020')).toEqual([7]);

    const r = await redeem(app, token, 'HWID-G20', key);
    expect(r.statusCode).toBe(409);
    expect(await daysLeft(db, '200000000000000020')).toEqual([7]);
  });

  it('21. key redeemed first: the pending grant pays nothing more at the next sign-in', async () => {
    const d = await deliver(app, { order_id: 'G21-1-1', ...WEEK, custom_fields: { discord_id: '210000000000000021' } });
    // Someone (the buyer or a friend) redeems the key on another account first.
    const friendToken = await signIn(app, '210000000000000099', 'HWID-G21-FRIEND');
    expect((await redeem(app, friendToken, 'HWID-G21-FRIEND', d.body.trim())).statusCode).toBe(200);

    await signIn(app, '210000000000000021', 'HWID-G21');
    expect(await daysLeft(db, '210000000000000021')).toEqual([]);
    expect(await daysLeft(db, '210000000000000099')).toEqual([7]);
  });

  it('22. an order refunded before the buyer signs in pays nothing', async () => {
    const d = await deliver(app, { order_id: 'G22-1-1', product_id: 112404, variant_id: 158298, custom_fields: { discord_id: '220000000000000022' } });
    const ban = await app.inject({
      method: 'POST',
      url: '/licenses/ban',
      headers: { 'x-admin-secret': ADMIN_SECRET },
      payload: { key: d.body.trim() },
    });
    expect(ban.statusCode).toBe(200);

    await signIn(app, '220000000000000022', 'HWID-G22');
    expect(await daysLeft(db, '220000000000000022')).toEqual([]);
  });

  it('23. a refund after the sign-in payout takes the access away', async () => {
    const d = await deliver(app, { order_id: 'G23-1-1', ...WEEK, custom_fields: { discord_id: '230000000000000023' } });
    await signIn(app, '230000000000000023', 'HWID-G23');
    expect(await daysLeft(db, '230000000000000023')).toEqual([7]);

    await app.inject({
      method: 'POST',
      url: '/licenses/ban',
      headers: { 'x-admin-secret': ADMIN_SECRET },
      payload: { key: d.body.trim() },
    });
    expect(await daysLeft(db, '230000000000000023')).toEqual(['revoked']);
  });

  it('24. bundle for a buyer not signed in yet: all three once, keys used up', async () => {
    const d = await deliver(app, { order_id: 'G24-1-1', ...BUNDLE, discord_id: '240000000000000024' });
    const token = await signIn(app, '240000000000000024', 'HWID-G24');
    expect(await daysLeft(db, '240000000000000024')).toEqual(['lifetime', 'lifetime', 'lifetime']);

    for (const key of d.body.split('\n')) {
      expect((await redeem(app, token, 'HWID-G24', key)).statusCode).toBe(409);
    }
    const keys = await db.select().from(licenseKeys);
    expect(keys.every((k: any) => k.redeemedBy === '240000000000000024')).toBe(true);
  });

  describe('store order with only a Discord name (motionlifeshop.com)', () => {
    beforeEach(() => {
      process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(((url: any, init?: any) => {
        const href = typeof url === 'string' ? url : url.toString();
        if (href.includes('discord.com')) {
          return Promise.resolve({ ok: true, json: async () => ({ username: 'namebuyer' }) } as Response);
        }
        return realFetch(url, init);
      }) as typeof fetch);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.DISCORD_BOT_TOKEN;
    });

    it('25. sign-in pays once, the order key is then used up, a later sign-in adds nothing', async () => {
      const d = await deliver(app, {
        event: 'INVOICE.ITEM.DELIVER-DYNAMIC',
        order_id: 'G25-1-1',
        ...WEEK,
        custom_fields: { 'Discord Name': 'namebuyer', discord_username: 'namebuyer' },
      });
      const token = await signIn(app, '250000000000000025', 'HWID-G25');
      expect(await daysLeft(db, '250000000000000025')).toEqual([7]);
      expect((await redeem(app, token, 'HWID-G25', d.body.trim())).statusCode).toBe(409);
      await signIn(app, '250000000000000025', 'HWID-G25');
      expect(await daysLeft(db, '250000000000000025')).toEqual([7]);
    });
  });
});

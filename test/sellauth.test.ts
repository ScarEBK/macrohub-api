import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { buildTestApp, deliver, insertUser } from './helpers.js';
import { licenseKeys, pendingEntitlements, migrationClaims, userMacros } from '../src/db/schema.js';

const BUNDLE = { product_id: 770856, variant_id: 1286386 };

describe('POST /sellauth/webhook — bundle orders', () => {
  let app: any;
  let db: any;

  beforeEach(async () => {
    app = await buildTestApp();
    db = app.db;
  });

  it('14. a bundle delivery returns three keys, one per macro', async () => {
    const r = await deliver(app, {
      event: 'INVOICE.ITEM.DELIVER-DYNAMIC',
      order_id: 'B14-1-1',
      ...BUNDLE,
      custom_fields: { 'Discord Name': 'bundlebuyer', discord_username: 'bundlebuyer' },
    });
    expect(r.statusCode).toBe(200);

    const keys = r.body.split('\n').filter(Boolean);
    expect(keys.length).toBe(3);
    expect(new Set(keys).size).toBe(3);

    const rows = await db.select().from(licenseKeys);
    expect(rows.map((k: any) => k.macro).sort()).toEqual(['Glitch Roll', 'Speed Boost', 'Strafe']);
    expect(rows.every((k: any) => k.duration === 'lifetime')).toBe(true);

    const claims = await db.select().from(migrationClaims);
    expect(claims.length).toBe(3);
  });

  it('15. a retried bundle delivery returns the same three keys and creates nothing new', async () => {
    const payload = {
      event: 'INVOICE.ITEM.DELIVER-DYNAMIC',
      order_id: 'B15-1-1',
      ...BUNDLE,
      discord_id: '150000000000000015',
    };
    const first = await deliver(app, payload);
    expect(first.statusCode).toBe(200);
    const again = await Promise.all([deliver(app, payload), deliver(app, payload)]);
    for (const r of again) {
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(first.body);
    }

    expect((await db.select().from(licenseKeys)).length).toBe(3);
    expect((await db.select().from(pendingEntitlements)).length).toBe(3);
  });

  it('16. two different bundle orders get their own keys', async () => {
    const a = await deliver(app, { order_id: 'B16-1-1', ...BUNDLE, custom_fields: {} });
    const b = await deliver(app, { order_id: 'B16-2-1', ...BUNDLE, custom_fields: {} });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).not.toBe(b.body);
    expect((await db.select().from(licenseKeys)).length).toBe(6);
  });
});

describe('POST /sellauth/webhook — buyer is already a user (discord_id)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let app: any;
  let db: any;

  beforeEach(async () => {
    app = await buildTestApp();
    db = app.db;
    await insertUser(db, '260000000000000026', 'hwid-26');
  });

  async function row(macro: string) {
    const [r] = await db
      .select()
      .from(userMacros)
      .where(and(eq(userMacros.discordId, '260000000000000026'), eq(userMacros.macro, macro)));
    return r;
  }
  const days = (r: any) => Math.round((+new Date(r.expiresAt) - Date.now()) / DAY_MS);

  it('26. two week orders stack to 14 days and the keys are used up', async () => {
    const a = await deliver(app, { order_id: 'U26-1-1', product_id: 112404, variant_id: 929412, discord_id: '260000000000000026' });
    const b = await deliver(app, { order_id: 'U26-2-1', product_id: 112404, variant_id: 929412, discord_id: '260000000000000026' });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const r = await row('Speed Boost');
    expect(r.status).toBe('active');
    expect(days(r)).toBe(14);

    const keys = await db.select().from(licenseKeys);
    expect(keys.every((k: any) => k.status === 'redeemed' && k.redeemedBy === '260000000000000026')).toBe(true);
  });

  it('27. a month on top of an active week adds 30 days (not years)', async () => {
    await deliver(app, { order_id: 'U27-1-1', product_id: 89525, variant_id: 929423, discord_id: '260000000000000026' });
    await deliver(app, { order_id: 'U27-2-1', product_id: 89525, variant_id: 929422, discord_id: '260000000000000026' });
    expect(days(await row('Glitch Roll'))).toBe(37);
  });

  it('28. a week bought by a lifetime owner keeps the lifetime', async () => {
    await deliver(app, { order_id: 'U28-1-1', product_id: 100843, variant_id: 151984, discord_id: '260000000000000026' });
    const r = await deliver(app, { order_id: 'U28-2-1', product_id: 100843, variant_id: 929404, discord_id: '260000000000000026' });
    expect(r.statusCode).toBe(200);
    expect((await row('Strafe')).expiresAt).toBeNull();
  });

  it('29. a bundle grants all three macros for life', async () => {
    const r = await deliver(app, { order_id: 'U29-1-1', ...BUNDLE, discord_id: '260000000000000026' });
    expect(r.statusCode).toBe(200);
    for (const m of ['Speed Boost', 'Glitch Roll', 'Strafe']) {
      const x = await row(m);
      expect(x.status).toBe('active');
      expect(x.expiresAt).toBeNull();
    }
  });
});

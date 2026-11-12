import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, deliver } from './helpers.js';
import { licenseKeys, pendingEntitlements, migrationClaims } from '../src/db/schema.js';

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

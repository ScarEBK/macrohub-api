import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { buildTestApp } from './helpers.js';
import { migrationClaims, userMacros } from '../src/db/schema.js';

const MOTIONCORD_SECRET = process.env.MOTIONCORD_DESKTOP_SECRET as string;

function buildProof(discordId: string, issuedAt: number, secret = MOTIONCORD_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${discordId}:${issuedAt}`).digest('hex');
}

async function oauth(app: any, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/auth/oauth', payload: body });
}

describe('POST /auth/oauth', () => {
  let app: any;
  let db: any;

  beforeEach(async () => {
    app = await buildTestApp();
    db = app.db;
  });

  it('10. username-only migration claim is NOT resolved without DISCORD_BOT_TOKEN', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const discordId = 'claim-user-10';
    const username = 'ClaimUsername10';
    await db.insert(migrationClaims).values({
      sellauthUsername: username,
      macro: 'Speed Boost',
      duration: '7d',
      status: 'pending',
    });

    const issuedAt = Date.now();
    const proof = buildProof(discordId, issuedAt);
    const r = await oauth(app, {
      discordId,
      username,
      hwid: 'hwid-10',
      oauthProof: proof,
      issuedAt,
    });
    expect(r.statusCode).toBe(200);

    const [claim] = await db.select().from(migrationClaims).where(eq(migrationClaims.sellauthUsername, username));
    expect(claim.status).toBe('pending');

    const macros = await db.select().from(userMacros).where(eq(userMacros.discordId, discordId));
    expect(macros.length).toBe(0);
  });

  it('11. claim with matching discordId IS resolved', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const discordId = 'claim-user-11';
    await db.insert(migrationClaims).values({
      discordId,
      macro: 'Speed Boost',
      duration: '7d',
      status: 'pending',
    });

    const issuedAt = Date.now();
    const proof = buildProof(discordId, issuedAt);
    const r = await oauth(app, {
      discordId,
      username: 'ClaimUser11',
      hwid: 'hwid-11',
      oauthProof: proof,
      issuedAt,
    });
    expect(r.statusCode).toBe(200);

    const macros = await db.select().from(userMacros).where(eq(userMacros.discordId, discordId));
    expect(macros.length).toBe(1);
    expect(macros[0].macro).toBe('Speed Boost');
  });

  describe('with DISCORD_BOT_TOKEN set and fetch mocked', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
      vi.spyOn(globalThis, 'fetch').mockImplementation(((url: any, init?: any) => {
        const href = typeof url === 'string' ? url : url.toString();
        if (href.includes('discord.com')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ username: 'realname' }),
          } as Response);
        }
        return realFetch(url, init);
      }) as typeof fetch);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.DISCORD_BOT_TOKEN;
    });

    it('12a. claim matching the verified Discord username resolves even if body.username differs', async () => {
      const discordId = '111111111111111111';
      await db.insert(migrationClaims).values({
        sellauthUsername: 'RealName',
        macro: 'Speed Boost',
        duration: '7d',
        status: 'pending',
      });

      const issuedAt = Date.now();
      const proof = buildProof(discordId, issuedAt);
      const r = await oauth(app, {
        discordId,
        username: 'someoneelse',
        hwid: 'hwid-12a',
        oauthProof: proof,
        issuedAt,
      });
      expect(r.statusCode).toBe(200);

      const macros = await db.select().from(userMacros).where(eq(userMacros.discordId, discordId));
      expect(macros.length).toBe(1);
    });

    it('12b. claim for an unrelated username does not resolve', async () => {
      const discordId = '222222222222222222';
      await db.insert(migrationClaims).values({
        sellauthUsername: 'someoneelse',
        macro: 'Glitch Roll',
        duration: '7d',
        status: 'pending',
      });

      const issuedAt = Date.now();
      const proof = buildProof(discordId, issuedAt);
      const r = await oauth(app, {
        discordId,
        username: 'someoneelse',
        hwid: 'hwid-12b',
        oauthProof: proof,
        issuedAt,
      });
      expect(r.statusCode).toBe(200);

      const macros = await db.select().from(userMacros).where(eq(userMacros.discordId, discordId));
      expect(macros.length).toBe(0);

      const [claim] = await db
        .select()
        .from(migrationClaims)
        .where(eq(migrationClaims.sellauthUsername, 'someoneelse'));
      expect(claim.status).toBe('pending');
    });
  });

  it('13. invalid proof => 401', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const discordId = 'invalid-proof-user';
    const issuedAt = Date.now();
    const r = await oauth(app, {
      discordId,
      username: 'InvalidProofUser',
      hwid: 'hwid-13',
      oauthProof: 'not-a-valid-proof',
      issuedAt,
    });
    expect(r.statusCode).toBe(401);
  });
});

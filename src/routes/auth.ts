import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { eq, and, lt, gt, or, ilike } from 'drizzle-orm';
import {
  users,
  desktopSessions,
  pendingEntitlements,
  migrationClaims,
  referralCodes,
  referralEvents,
  userMacros,
} from '../db/schema.js';
import { verifyOAuthProof, generateSessionToken, timingSafeEqual } from '../lib/crypto.js';
import { adminAuth, desktopSessionAuth, AuthenticatedRequest } from '../middleware/auth.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MOTIONCORD_DESKTOP_SECRET = process.env.MOTIONCORD_DESKTOP_SECRET ?? '';

// Duration → milliseconds (lifetime = null expiry). Used by the migration-claim
// merge to extend timed macros when a returning customer has multiple claims
// for the same macro (stacking).
const DURATION_MS_AUTH: Record<string, number | null> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'lifetime': null,
};

/**
 * Upsert a userMacro with extend-on-conflict semantics (mirrors
 * /licenses/redeem + /migration/import-row). Used by the migration-claim merge
 * so a returning customer with multiple pending claims for the same macro gets
 * them stacked (extended) rather than silently dropped (onConflictDoNothing).
 */
async function upsertUserMacroExtendAuth(
  db: any,
  discordId: string,
  macro: string,
  duration: string,
): Promise<void> {
  const durationMs = DURATION_MS_AUTH[duration] ?? (30 * 24 * 60 * 60 * 1000);
  const lifetime = duration === 'lifetime' || durationMs === null;

  const existing = await db.select().from(userMacros)
    .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, macro)))
    .limit(1).then((rows: any[]) => rows[0] ?? null);

  if (!existing) {
    await db.insert(userMacros).values({
      discordId, macro, status: 'active', source: 'migration', duration,
      expiresAt: lifetime ? undefined : new Date(Date.now() + (durationMs ?? 0)),
    });
    return;
  }

  if (lifetime) {
    // Upgrade timed → lifetime; never downgrade lifetime.
    if (existing.expiresAt === null) return;
    await db.update(userMacros).set({ expiresAt: null, status: 'active', duration: 'lifetime' })
      .where(eq(userMacros.id, existing.id));
    return;
  }

  // Timed: extend existing expiry (don't downgrade a lifetime owner).
  if (existing.expiresAt === null) return;
  const now = Date.now();
  const base = Math.max(new Date(existing.expiresAt).getTime(), now);
  await db.update(userMacros).set({ expiresAt: new Date(base + (durationMs ?? 0)), status: 'active' })
    .where(eq(userMacros.id, existing.id));
}

const authPlugin: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // ── POST /auth/oauth ────────────────────────────────────────────────────────
  app.post<{
    Body: {
      discordId: string;
      username: string;
      avatar?: string;
      avatarUrl?: string;
      hwid: string;
      oauthProof: string;
      issuedAt?: number;
      oauthProofAt?: number;
      referralCode?: string;
    };
  }>('/auth/oauth', async (request, reply) => {
    const body = request.body;
    const discordId = body.discordId;
    const username = body.username;
    const avatar = body.avatar ?? body.avatarUrl;
    const hwid = body.hwid;
    const oauthProof = body.oauthProof;
    const issuedAt = body.issuedAt ?? body.oauthProofAt ?? 0;

    const referralCode = body.referralCode;
    const { db } = request.server;

    // ── 1. Verify OAuth proof or admin secret ──────────────────────────────────
    const adminSecret = request.headers['x-admin-secret'];
    const isAdminBypass = typeof adminSecret === 'string'
      && process.env.ADMIN_SECRET
      && timingSafeEqual(adminSecret, process.env.ADMIN_SECRET);

    // Validate OAuth proof timestamp (skip if admin bypass)
    if (!isAdminBypass && !body.issuedAt && !body.oauthProofAt) {
      return reply.code(400).send({ error: 'Missing OAuth proof timestamp (issuedAt or oauthProofAt)' });
    }

    if (!isAdminBypass) {
      // Mandatory OAuth proof when MOTIONCORD_DESKTOP_SECRET is configured
      if (!MOTIONCORD_DESKTOP_SECRET) {
        return reply.code(500).send({ error: 'Server misconfiguration: OAuth secret missing' });
      }
      if (!oauthProof) {
        return reply.code(401).send({ error: 'Missing OAuth proof — MotionCord secret may not be configured' });
      }
      if (!verifyOAuthProof(discordId, issuedAt, oauthProof, MOTIONCORD_DESKTOP_SECRET)) {
        return reply.code(401).send({ error: 'Invalid OAuth proof' });
      }
    }

    // ── 2. Find or create user ─────────────────────────────────────────────────
    let user = await db.select().from(users).where(eq(users.discordId, discordId)).then((rows: any[]) => rows[0] ?? null);

    const isNewUser = user === null;

    if (isNewUser) {
      const inserted = await db.insert(users).values({
        discordId,
        username,
        avatarUrl: avatar ?? null,
        hwid,
        lastSeenAt: new Date(),
      }).returning();
      user = inserted[0];
    } else {
      // Update username/avatar on each login
      await db.update(users).set({
        username,
        avatarUrl: avatar ?? user.avatarUrl,
        lastSeenAt: new Date(),
      }).where(eq(users.discordId, discordId));
      user = { ...user, username, avatarUrl: avatar ?? user.avatarUrl };
    }

    // ── 3. HWID binding logic ──────────────────────────────────────────────────
    if (!isNewUser) {
      const storedHwid = user.hwid;

      if (storedHwid && storedHwid !== hwid) {
        // Auto-migrate legacy 32-char SHA256 hashes
        if (storedHwid.length === 32) {
          await db.update(users).set({ hwid }).where(eq(users.discordId, discordId));
          user = { ...user, hwid };
        } else if (user.hwidResetAllowed) {
          const newCount = (user.hwidResetCount ?? 0) + 1;
          await db.update(users).set({ hwid, hwidResetAllowed: false, hwidResetCount: newCount }).where(eq(users.discordId, discordId));
          user = { ...user, hwid, hwidResetAllowed: false, hwidResetCount: newCount };
        } else {
          return reply.code(403).send({ error: 'HWID_MISMATCH' });
        }
      } else if (!storedHwid) {
        await db.update(users).set({ hwid }).where(eq(users.discordId, discordId));
        user = { ...user, hwid };
      }
    }

    // ── 4. Merge pending entitlements ───────────────────────────────────────────
    const entitlements = await db.select().from(pendingEntitlements)
      .where(eq(pendingEntitlements.discordId, discordId));

    for (const ent of entitlements) {
      // Skip if entitlement has expired
      if (ent.expiresAt && new Date(ent.expiresAt) <= new Date()) {
        await db.delete(pendingEntitlements).where(eq(pendingEntitlements.id, ent.id));
        continue;
      }

      await db.insert(userMacros).values({
        discordId,
        macro: ent.macro,
        source: ent.source,
        duration: ent.duration,
      }).onConflictDoNothing();
      await db.delete(pendingEntitlements).where(eq(pendingEntitlements.id, ent.id));
    }

    // ── 5. Merge migration claims ───────────────────────────────────────────────
    // Match by discordId OR by sellauthUsername (case-insensitive). SellAuth
    // buyers typed a "Discord Name" custom field, so most migration claims only
    // carry a sellauthUsername, not a discordId. The username match lets a
    // returning customer's claims auto-resolve on their first sign-in.
    const claims = await db.select().from(migrationClaims)
      .where(and(
        or(
          eq(migrationClaims.discordId, discordId),
          ilike(migrationClaims.sellauthUsername, username.trim()),
        ),
        eq(migrationClaims.status, 'pending'),
      ));

    for (const claim of claims) {
      // Extend-on-conflict: a returning customer with multiple claims for the
      // same macro gets them stacked (expiry extended), not dropped.
      await upsertUserMacroExtendAuth(db, discordId, claim.macro, claim.duration);
      await db.update(migrationClaims).set({ status: 'resolved' })
        .where(eq(migrationClaims.id, claim.id));
    }

    // ── 6. Referral code (new users only) ──────────────────────────────────────
    if (isNewUser && referralCode) {
      const ref = await db.select().from(referralCodes)
        .where(eq(referralCodes.code, referralCode))
        .then((rows: any[]) => rows[0] ?? null);

      if (ref) {
        await db.update(users).set({ referredByDiscordId: ref.discordId })
          .where(eq(users.discordId, discordId));
        user = { ...user, referredByDiscordId: ref.discordId };

        await db.insert(referralEvents).values({
          referrerDiscordId: ref.discordId,
          referredDiscordId: discordId,
          eventType: 'install',
        });
      }
    }

    // ── 7. Invalidate existing sessions ─────────────────────────────────────────
    await db.delete(desktopSessions)
      .where(eq(desktopSessions.discordId, discordId));

    // ── 8. Create new session ──────────────────────────────────────────────────
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

    await db.insert(desktopSessions).values({
      discordId,
      token: sessionToken,
      hwid,
      expiresAt,
    });

    return reply.send({
      user: {
        discordId: user.discordId,
        username: user.username,
        avatarUrl: user.avatarUrl,
        hwid: user.hwid,
        referredByDiscordId: user.referredByDiscordId ?? null,
      },
      sessionToken,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // ── POST /auth/session ──────────────────────────────────────────────────────
  app.post('/auth/session', { preHandler: [desktopSessionAuth] }, async (request, reply) => {
    const { discordId } = (request as AuthenticatedRequest).session;
    const { db } = request.server;

    const user = await db.select().from(users)
      .where(eq(users.discordId, discordId))
      .then((rows: any[]) => rows[0] ?? null);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const macros = await db.select().from(userMacros)
      .where(eq(userMacros.discordId, discordId));

    return reply.send({
      user: {
        discordId: user.discordId,
        username: user.username,
        avatarUrl: user.avatarUrl,
        hwid: user.hwid,
      },
      macros,
    });
  });

  // ── POST /auth/signout ──────────────────────────────────────────────────────
  app.post('/auth/signout', { preHandler: [desktopSessionAuth] }, async (request, reply) => {
    const token = request.headers['x-session-token'];
    const { db } = request.server;

    if (typeof token === 'string') {
      await db.delete(desktopSessions).where(eq(desktopSessions.token, token));
    }

    return reply.send({ ok: true });
  });

  // ── GET /auth/hwid-check ─────────────────────────────────────────────────────
  app.get<{ Querystring: { hwid?: string } }>('/auth/hwid-check', async (request, reply) => {
    const hwid = request.query.hwid;

    if (!hwid) {
      return reply.code(400).send({ error: 'Missing hwid query parameter' });
    }

    const { db } = request.server;

    const user = await db.select({
      discordId: users.discordId,
    }).from(users)
      .where(eq(users.hwid, hwid))
      .then((rows: any[]) => rows[0] ?? null);

    if (!user) {
      return reply.send({ bound: false });
    }

    return reply.send({ bound: true, discordId: user.discordId });
  });

  // ── POST /auth/reset-hwid ────────────────────────────────────────────────────
  app.post<{ Body: { discordId: string } }>('/auth/reset-hwid', { preHandler: [adminAuth] }, async (request, reply) => {
    const { discordId } = request.body;
    const { db } = request.server;

    await db.update(users).set({ hwidResetAllowed: true })
      .where(eq(users.discordId, discordId));

    return reply.send({ ok: true });
  });

  // ── POST /auth/clear-hwid ────────────────────────────────────────────────────
  app.post<{ Body: { discordId: string } }>('/auth/clear-hwid', { preHandler: [adminAuth] }, async (request, reply) => {
    const { discordId } = request.body;
    const { db } = request.server;

    await db.update(users).set({ hwid: null })
      .where(eq(users.discordId, discordId));

    return reply.send({ ok: true });
  });

  done();
};

export default authPlugin;
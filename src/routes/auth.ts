import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { eq, and, lt, gt, or, sql } from 'drizzle-orm';
import {
  users,
  desktopSessions,
  pendingEntitlements,
  migrationClaims,
  referralCodes,
  userMacros,
  trialRegistrations,
  adminLogs,
} from '../db/schema.js';
import { grantInstallReward } from './referrals.js';
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
  // If the existing row is revoked, start from now so a reactivated user does
  // not get leftover revoked time stacked onto the new grant.
  if (existing.expiresAt === null) return;
  const now = Date.now();
  const existingExpires = new Date(existing.expiresAt).getTime();
  const base = existing.status === 'active' ? Math.max(existingExpires, now) : now;
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
          // C-5 fix (audit 2026-06-19): atomic check-and-consume of the reset
          // grant via a single conditional UPDATE ... RETURNING, mirroring the
          // desktopSessionAuth middleware. Prevents two concurrent OAuth
          // sign-ins from both rebinding to different HWIDs and losing the
          // hwidResetCount increment.
          const consumed = await db
            .update(users)
            .set({ hwid, hwidResetAllowed: false, hwidResetCount: sql`${users.hwidResetCount} + 1` })
            .where(and(eq(users.discordId, discordId), eq(users.hwidResetAllowed, true)))
            .returning({ id: users.id });
          if (consumed.length === 1) {
            user = { ...user, hwid, hwidResetAllowed: false, hwidResetCount: (user.hwidResetCount ?? 0) + 1 };
          } else {
            // Grant was consumed by a concurrent sign-in between our read and
            // update. Treat like no grant available.
            return reply.code(403).send({ error: 'HWID_REBIND_AVAILABLE' });
          }
        } else {
          // Signed in on a new PC with no reset grant. Return a distinct code
          // so the desktop can show a clear "contact support to transfer"
          // message instead of a generic sign-in failure. The user must
          // request an HWID reset via the Discord bot (`/macrohub reset-hwid`),
          // which sets `hwidResetAllowed` and lets the next sign-in rebind.
          return reply.code(403).send({ error: 'HWID_REBIND_AVAILABLE' });
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

      // Stack: a repeat buyer of the same macro should have their duration
      // extended, not silently dropped. The previous version used
      // onConflictDoNothing which dropped the grant if the user already owned
      // the macro — inconsistent with /licenses/redeem and the migration-claim
      // merge, both of which stack via upsertUserMacroExtendAuth.
      await upsertUserMacroExtendAuth(db, discordId, ent.macro, ent.duration);
      await db.delete(pendingEntitlements).where(eq(pendingEntitlements.id, ent.id));
    }

    // ── 5. Merge migration claims ───────────────────────────────────────────────
    // Match by discordId OR by sellauthUsername (exact case-insensitive). We use
    // lower() = lower() instead of ilike() to avoid wildcard injection (% and _
    // are ilike wildcards that could match unintended claims). This also prevents
    // username-squatting attacks where an attacker changes their Discord username
    // to a partial match of a victim's pending claim.
    //
    // SECURITY NOTE: username-based claim resolution carries an inherent risk —
    // if an attacker changes their Discord username to exactly match a buyer's
    // SellAuth "Discord Name" custom field, they could steal the buyer's macros.
    // This is accepted as a tradeoff because: (1) Discord usernames are unique
    // at any point in time, (2) the attacker would need to know the exact name
    // the buyer typed, (3) claims are typically resolved quickly after purchase.
    // For high-value claims, prefer discordId-based resolution.
    const trimmedUsername = username.trim().toLowerCase();
    const claims = await db.select().from(migrationClaims)
      .where(and(
        or(
          eq(migrationClaims.discordId, discordId),
          sql`lower(${migrationClaims.sellauthUsername}) = ${trimmedUsername}`,
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

        // C-2 fix (audit 2026-06-19): actually GRANT the install reward days
        // to the referrer's active macros. Previously this only inserted a
        // referralEvents row with no daysAwarded, so referrers got nothing.
        // grantInstallReward handles the dedup + monthly cap + day-granting
        // + event insert in one call.
        await grantInstallReward(db, ref.discordId, discordId).catch((e) => {
          // Non-fatal: don't fail the sign-in if the reward grant errors.
          request.log.error({ err: e }, 'install referral reward failed');
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
  // Admin-only: previously unauthenticated, which let anyone enumerate whether
  // a HWID was bound and to which Discord ID. Restricted to admins now; the
  // desktop doesn't use this endpoint (it learns HWID state via /auth/oauth).
  app.get<{ Querystring: { hwid?: string } }>('/auth/hwid-check', { preHandler: [adminAuth] }, async (request, reply) => {
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

    // H-12 fix (audit 2026-06-19): previously this was a blind update that
    // returned {ok:true} even for a discordId with no user row, so the bot
    // told the admin "Cleared HWID for X" for a non-existent user and the
    // user then still failed HWID mismatch — a support loop. Now verify the
    // user exists first and 404 if not.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.discordId, discordId))
      .limit(1);
    if (!existing) {
      return reply.code(404).send({ error: 'No user found with that Discord ID.' });
    }

    // Mirror the legacy Convex clearHwidForBot: null the stored HWID AND set
    // hwidResetAllowed = true so the user's next sign-in on the new machine
    // rebinds cleanly (the stored-hwid is null, so the /auth/oauth "no stored
    // HWID" branch binds the fresh one directly; the reset flag is also
    // consumed defensively if a stale session tries a redeem first). The
    // previous version only cleared hwid, so the user had to fully sign out
    // and back in for the reset to take effect.
    await db.update(users).set({
      hwid: null,
      hwidResetAllowed: true,
    })
      .where(eq(users.discordId, discordId));

    // M-11 fix (audit 2026-06-19): invalidate existing desktop sessions for
    // this user so the OLD machine can't keep using a stale token until it
    // expires (up to 30 days). The user must re-sign-in on the new machine,
    // which is the intended flow after an HWID reset.
    await db.delete(desktopSessions)
      .where(eq(desktopSessions.discordId, discordId));

    // H-4 fix (audit 2026-06-19): clear the user's trial registrations too,
    // so an HWID reset can't bypass the one-trial-per-machine lock. Without
    // this, a user could reset HWID, re-sign-in (new users.hwid), and claim a
    // 2nd trial because trialRegistrations still held the old HWID.
    await db.delete(trialRegistrations)
      .where(eq(trialRegistrations.discordId, discordId));

    // H-2 fix (audit 2026-06-19): audit trail.
    await db.insert(adminLogs).values({
      action: 'clear_hwid',
      actorDiscordId: 'bot',
      targetDiscordId: discordId,
      details: JSON.stringify({}),
    });

    return reply.send({ ok: true });
  });

  done();
};

export default authPlugin;
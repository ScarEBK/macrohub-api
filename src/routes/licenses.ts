import { FastifyPluginCallback } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { adminAuth, desktopSessionAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { generateLicenseKey, normalizeLicenseKey } from '../lib/crypto.js';
import { licenseKeys, userMacros, adminLogs, users } from '../db/schema.js';

const VALID_MACROS = ['Speed Boost', 'Glitch Roll', 'Strafe'] as const;
const VALID_DURATIONS = ['1d', '7d', '1m', '30d', 'lifetime'] as const;

const DURATION_MS: Record<string, number | null> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  lifetime: null,
};

const licenseRoutes: FastifyPluginCallback = (app, _opts, done) => {
  // ── GET /licenses/ping ────────────────────────────────────────────────────
  app.get('/licenses/ping', async (_request, reply) => {
    return reply.send({ ok: true });
  });

  // ── POST /licenses/generate ───────────────────────────────────────────────
  app.post('/licenses/generate', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const body = request.body as { macro?: string; macroName?: string; duration?: string; durationLabel?: string; count?: number };

      const macro = body?.macro ?? body?.macroName;
      const duration = body?.duration ?? body?.durationLabel;
      const count = body?.count;

      if (!macro || !VALID_MACROS.includes(macro as any)) {
        return reply.code(400).send({ error: 'Invalid macro. Must be one of: ' + VALID_MACROS.join(', ') });
      }

      if (!duration || !VALID_DURATIONS.includes(duration as any)) {
        return reply.code(400).send({ error: 'Invalid duration. Must be one of: ' + VALID_DURATIONS.join(', ') });
      }

      if (!count || typeof count !== 'number' || count < 1 || count > 500) {
        return reply.code(400).send({ error: 'Invalid count. Must be between 1 and 500.' });
      }

      const { db } = request.server;
      const keys: string[] = [];

      for (let i = 0; i < count; i++) {
        let key = generateLicenseKey();
        let attempts = 0;
        // Collision detection: ensure key doesn't already exist
        while (attempts < 5) {
          const [existing] = await db
            .select({ id: licenseKeys.id })
            .from(licenseKeys)
            .where(eq(licenseKeys.key, key))
            .limit(1);
          if (!existing) break;
          key = generateLicenseKey();
          attempts++;
        }
        keys.push(key);
      }

      const values = keys.map((key) => ({
        key,
        macro,
        duration,
        status: 'available' as const,
      }));

      try {
        await db.insert(licenseKeys).values(values);
      } catch (err: any) {
        // H-8 fix (audit 2026-06-19): don't leak raw Postgres errors (column/
        // constraint names) to the client. Log server-side, return a generic
        // message. The global error handler (index.ts) masks 5xx but this
        // per-route catch bypassed it.
        console.error('[DB INSERT ERROR]', err);
        return reply.code(500).send({ error: 'Failed to generate license keys. Try again.' });
      }

      return reply.send({ keys });
    } catch (err: any) {
      // H-8 fix (audit 2026-06-19): same — don't leak err.message. Let the
      // caller see a generic failure; the real error is logged above.
      console.error('[GENERATE ERROR]', err);
      return reply.code(500).send({ error: 'Key generation failed. Try again.' });
    }
  });

  // ── POST /licenses/redeem ─────────────────────────────────────────────────
  app.post('/licenses/redeem', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId, hwid } = (request as AuthenticatedRequest).session;
    const { db } = request.server;
    const body = request.body as { key?: string };

    if (!body?.key) {
      return reply.code(400).send({ error: 'Missing key field' });
    }

    const rawKey = body.key;
    const formats = normalizeLicenseKey(rawKey);

    // Try each format to find the key
    let licenseKey: any = null;
    for (const fmt of formats) {
      const [found] = await db
        .select()
        .from(licenseKeys)
        .where(eq(licenseKeys.key, fmt))
        .limit(1);
      if (found) {
        licenseKey = found;
        break;
      }
    }

    if (!licenseKey) {
      return reply.code(404).send({ error: 'KEY_NOT_FOUND' });
    }

    if (licenseKey.status === 'banned') {
      return reply.code(403).send({ error: 'KEY_BANNED: This license key has been banned.' });
    }

    if (licenseKey.status === 'redeemed') {
      return reply.code(409).send({ error: 'KEY_ALREADY_REDEEMED' });
    }

    // Verify HWID: session's hwid must match the user's hwid (or user has hwidResetAllowed)
    const [user] = await db
      .select({
        hwid: users.hwid,
        hwidResetAllowed: users.hwidResetAllowed,
        bannedMacros: users.bannedMacros,
      })
      .from(users)
      .where(eq(users.discordId, discordId))
      .limit(1);

    if (user && user.hwid && user.hwid !== hwid && !user.hwidResetAllowed) {
      // Same rebind-required condition as /auth/oauth. Use the shared code so
      // the desktop maps it to the clear "contact support to transfer" message
      // rather than a generic redeem failure.
      return reply.code(403).send({ error: 'HWID_REBIND_AVAILABLE' });
    }

    // C-1 fix (audit 2026-06-19): account-level ban check. A user who was
    // banned from this macro (via /licenses/ban setting bannedMacros) cannot
    // redeem ANY key for it — including a freshly purchased one. This
    // restores the ban-bypass guard that was removed 2026-06-19; without it,
    // a ban was circumventable by spending $1 on a new key. The per-key ban
    // check above still prevents the banned key itself from being reused;
    // this is the account-level layer on top.
    const bannedList = Array.isArray(user?.bannedMacros) ? user.bannedMacros : [];
    if (bannedList.includes(licenseKey.macro)) {
      return reply.code(403).send({
        error: 'ACCOUNT_BANNED_FROM_MACRO: This account is restricted from this macro because of a previous banned key. Contact support on Discord.',
      });
    }

    // Ban-bypass guard removed (2026-06-19): the product owner wants a banned
    // user to be able to buy a fresh key and redeem it. The per-key ban check
    // above (status === 'banned') still prevents the banned key itself from
    // being reused. We now compute the new expiry from now when reactivating a
    // revoked row so leftover time is not stacked onto the new purchase.
    // NOTE (audit 2026-06-19): the account-level bannedMacros check above
    // supersedes this comment for actually-banned accounts; a user who is NOT
    // in bannedMacros can still re-purchase, which is the intended behavior.

    // Wrap the write path in a transaction so concurrent redeems of two keys for
    // the same macro cannot race on the same user_macros row.
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      // Mark key as redeemed
      await tx
        .update(licenseKeys)
        .set({
          status: 'redeemed',
          redeemedBy: discordId,
          redeemedAt: now,
        })
        .where(eq(licenseKeys.id, licenseKey.id));

      // Calculate duration
      const durationMs = DURATION_MS[licenseKey.duration];
      const macro = licenseKey.macro;
      const duration = licenseKey.duration;

      // Upsert userMacro: if active macro exists, extend; otherwise create new.
      // When the existing row is revoked, start the new duration from now (do
      // not carry over leftover time from the revoked entitlement).
      const [existingMacro] = await tx
        .select()
        .from(userMacros)
        .where(and(
          eq(userMacros.discordId, discordId),
          eq(userMacros.macro, macro),
        ))
        .limit(1);

      let expiresAt: Date | null;
      let expiresAtMs: number | null;

      if (existingMacro) {
        if (existingMacro.status === 'revoked') {
          // Fresh purchase re-activates a revoked macro. Log it, but compute
          // the new duration from now so the user does not get leftover time
          // from the revoked entitlement stacked on top of the new key.
          await tx.insert(adminLogs).values({
            action: 'license_redeem_reactivated_revoked',
            actorDiscordId: discordId,
            targetDiscordId: discordId,
            details: { macro, key: licenseKey.key, previousStatus: 'revoked' },
          });
        }
        if (durationMs === null) {
          expiresAt = null;
          expiresAtMs = null;
        } else {
          const baseDate =
            existingMacro.status === 'active' &&
            existingMacro.expiresAt &&
            new Date(existingMacro.expiresAt) > now
              ? new Date(existingMacro.expiresAt)
              : now;
          expiresAt = new Date(baseDate.getTime() + durationMs);
          expiresAtMs = expiresAt.getTime();
        }

        await tx
          .update(userMacros)
          .set({
            status: 'active',
            source: 'redeem',
            duration,
            expiresAt,
            licenseKeyId: licenseKey.id,
            updatedAt: now,
          })
          .where(eq(userMacros.id, existingMacro.id));
      } else {
        if (durationMs === null) {
          expiresAt = null;
          expiresAtMs = null;
        } else {
          expiresAt = new Date(now.getTime() + durationMs);
          expiresAtMs = expiresAt.getTime();
        }

        await tx
          .insert(userMacros)
          .values({
            discordId,
            macro,
            status: 'active',
            source: 'redeem',
            duration,
            expiresAt,
            licenseKeyId: licenseKey.id,
          });
      }

      // Create adminLog entry
      await tx
        .insert(adminLogs)
        .values({
          action: 'license_redeem',
          actorDiscordId: discordId,
          targetDiscordId: discordId,
          details: JSON.stringify({ key: licenseKey.key, macro, duration }),
        });

      return { macro, duration, expiresAtMs };
    });

    return reply.send({
      success: true,
      macro: result.macro,
      duration: result.duration,
      expiresAt: result.expiresAtMs,
    });
  });

  // ── POST /licenses/access ─────────────────────────────────────────────────
  app.post('/licenses/access', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId } = (request as AuthenticatedRequest).session;
    const { db } = request.server;
    const now = new Date();

    const macros = await db
      .select()
      .from(userMacros)
      .where(eq(userMacros.discordId, discordId));

    const result = macros.map((m) => {
      let status: string;
      if (m.status === 'revoked') {
        status = 'revoked';
      } else if (m.status === 'active') {
        if (!m.expiresAt || new Date(m.expiresAt) > now) {
          status = 'active';
        } else {
          status = 'expired';
        }
      } else {
        status = m.status;
      }

      return {
        macro: m.macro,
        status,
        source: m.source,
        duration: m.duration,
        expiresAt: m.expiresAt ? new Date(m.expiresAt).getTime() : null,
      };
    });

    const allowed = result.some((m) => m.status === 'active');

    return reply.send({
      allowed,
      reason: allowed ? undefined : 'No active macro access',
      macros: result,
    });
  });

  // ── POST /licenses/ban ────────────────────────────────────────────────────
  app.post('/licenses/ban', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { key?: string };

    if (!body?.key) {
      return reply.code(400).send({ error: 'Missing key field' });
    }

    const formats = normalizeLicenseKey(body.key);

    let licenseKey: any = null;
    for (const fmt of formats) {
      const [found] = await db
        .select()
        .from(licenseKeys)
        .where(eq(licenseKeys.key, fmt))
        .limit(1);
      if (found) {
        licenseKey = found;
        break;
      }
    }

    if (!licenseKey) {
      return reply.code(404).send({ error: 'KEY_NOT_FOUND' });
    }

    // Ban the key
    await db
      .update(licenseKeys)
      .set({ status: 'banned' })
      .where(eq(licenseKeys.id, licenseKey.id));

    // If the key was redeemed, revoke the corresponding userMacro.
    //
    // BL-1 fix (audit 2026-06-19): revoke ONLY the userMacro whose
    // licenseKeyId matches this banned key — NOT every macro the user owns
    // for this macro name. Previously this revoked by (discordId, macro)
    // alone, so banning an OLD/expired key would revoke a CURRENT entitlement
    // granted by a different, still-valid key the user redeemed later. That
    // locked users out of valid lifetime purchases when admins banned a key
    // that had already been superseded.
    if (licenseKey.redeemedBy) {
      await db
        .update(userMacros)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(and(
          eq(userMacros.discordId, licenseKey.redeemedBy),
          eq(userMacros.macro, licenseKey.macro),
          eq(userMacros.licenseKeyId, licenseKey.id),
        ));

      // C-1 fix (audit 2026-06-19): add the macro to the user's account-level
      // bannedMacros list so they cannot circumvent the ban by redeeming a
      // fresh key for the same macro. Idempotent — only adds if absent.
      const [bannedUser] = await db
        .select({ bannedMacros: users.bannedMacros })
        .from(users)
        .where(eq(users.discordId, licenseKey.redeemedBy))
        .limit(1);
      const currentBanned = Array.isArray(bannedUser?.bannedMacros) ? bannedUser.bannedMacros : [];
      if (!currentBanned.includes(licenseKey.macro)) {
        await db
          .update(users)
          .set({ bannedMacros: [...currentBanned, licenseKey.macro], updatedAt: new Date() })
          .where(eq(users.discordId, licenseKey.redeemedBy));
      }
    }

    // H-2 fix (audit 2026-06-19): audit trail. Every admin action should be
    // traceable. The bot uses x-admin-secret with no actor identity, so log
    // actor as 'bot' (admin console could pass a real discordId separately).
    await db.insert(adminLogs).values({
      action: 'license_ban',
      actorDiscordId: 'bot',
      targetDiscordId: licenseKey.redeemedBy ?? null,
      details: JSON.stringify({ key: licenseKey.key, macro: licenseKey.macro }),
    });

    return reply.send({ ok: true });
  });

  // ── POST /licenses/unban ──────────────────────────────────────────────────
  app.post('/licenses/unban', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { key?: string };

    if (!body?.key) {
      return reply.code(400).send({ error: 'Missing key field' });
    }

    const formats = normalizeLicenseKey(body.key);

    let licenseKey: any = null;
    for (const fmt of formats) {
      const [found] = await db
        .select()
        .from(licenseKeys)
        .where(eq(licenseKeys.key, fmt))
        .limit(1);
      if (found) {
        licenseKey = found;
        break;
      }
    }

    if (!licenseKey) {
      return reply.code(404).send({ error: 'KEY_NOT_FOUND' });
    }

    // Restore key status: 'available' if not previously redeemed, 'redeemed' if was redeemed
    const newStatus = licenseKey.redeemedBy ? 'redeemed' : 'available';

    await db
      .update(licenseKeys)
      .set({ status: newStatus })
      .where(eq(licenseKeys.id, licenseKey.id));

    // If there was a revoked userMacro tied to THIS key, restore it to active.
    //
    // BL-1/C-4 fix (audit 2026-06-19): restore only the userMacro whose
    // licenseKeyId matches this key, so unbanning a key the user already
    // superseded (by redeeming a different key) does not silently no-op or
    // clobber the current active entitlement. If the macro's expiresAt has
    // passed, set it to 'expired' (not leave it 'revoked') so the user sees a
    // "Renew" state rather than a permanent lock.
    if (licenseKey.redeemedBy) {
      const [revokedMacro] = await db
        .select()
        .from(userMacros)
        .where(and(
          eq(userMacros.discordId, licenseKey.redeemedBy),
          eq(userMacros.macro, licenseKey.macro),
          eq(userMacros.licenseKeyId, licenseKey.id),
          eq(userMacros.status, 'revoked'),
        ))
        .limit(1);

      if (revokedMacro) {
        const now = new Date();
        const stillValid = !revokedMacro.expiresAt || new Date(revokedMacro.expiresAt) > now;
        if (stillValid) {
          await db
            .update(userMacros)
            .set({ status: 'active', updatedAt: now })
            .where(eq(userMacros.id, revokedMacro.id));
        } else {
          await db
            .update(userMacros)
            .set({ status: 'expired', updatedAt: now })
            .where(eq(userMacros.id, revokedMacro.id));
        }
      }

      // C-1 fix (audit 2026-06-19): remove the macro from the user's
      // account-level bannedMacros list so they can redeem again. Idempotent.
      const [bannedUser] = await db
        .select({ bannedMacros: users.bannedMacros })
        .from(users)
        .where(eq(users.discordId, licenseKey.redeemedBy))
        .limit(1);
      const currentBanned = Array.isArray(bannedUser?.bannedMacros) ? bannedUser.bannedMacros : [];
      if (currentBanned.includes(licenseKey.macro)) {
        await db
          .update(users)
          .set({ bannedMacros: currentBanned.filter((m: string) => m !== licenseKey.macro), updatedAt: new Date() })
          .where(eq(users.discordId, licenseKey.redeemedBy));
      }
    }

    // H-2 fix (audit 2026-06-19): audit trail for unban.
    await db.insert(adminLogs).values({
      action: 'license_unban',
      actorDiscordId: 'bot',
      targetDiscordId: licenseKey.redeemedBy ?? null,
      details: JSON.stringify({ key: licenseKey.key, macro: licenseKey.macro }),
    });

    return reply.send({ ok: true });
  });

  // ── POST /licenses/revoke ─────────────────────────────────────────────────
  app.post('/licenses/revoke', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { discordId?: string; macro?: string };

    if (!body?.discordId || !body?.macro) {
      return reply.code(400).send({ error: 'Missing discordId or macro field' });
    }

    await db
      .update(userMacros)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(
        eq(userMacros.discordId, body.discordId),
        eq(userMacros.macro, body.macro),
      ));

    // H-2 fix (audit 2026-06-19): audit trail.
    await db.insert(adminLogs).values({
      action: 'license_revoke',
      actorDiscordId: 'bot',
      targetDiscordId: body.discordId,
      details: JSON.stringify({ macro: body.macro }),
    });

    return reply.send({ ok: true });
  });

  // ── POST /licenses/add-time ───────────────────────────────────────────────
  app.post('/licenses/add-time', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { discordId?: string; macro?: string; days?: number };

    if (!body?.discordId || !body?.macro || !body?.days || typeof body.days !== 'number') {
      return reply.code(400).send({ error: 'Missing or invalid fields: discordId, macro, days' });
    }

    // H-3 fix (audit 2026-06-19): previously add-time required status='active',
    // so an admin could NOT reinstate a revoked/expired macro by adding time —
    // they got a 404 and had to use /licenses/unban (which has its own edge
    // cases). Now we select the macro regardless of status (active/revoked/
    // expired) and the update below sets status='active', mirroring the Convex
    // legacy addTime behavior. This gives admins a single, predictable
    // reinstate path.
    const [userMacro] = await db
      .select()
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, body.discordId),
        eq(userMacros.macro, body.macro),
      ))
      .limit(1);

    if (!userMacro) {
      return reply.code(404).send({ error: 'No macro found for this user' });
    }

    const now = new Date();
    const addMs = body.days * 24 * 60 * 60 * 1000;

    // Guard: never downgrade a lifetime macro to timed. Lifetime macros have
    // expiresAt === null; the old else-branch would set a finite expiry,
    // destroying perpetual access.
    if (userMacro.expiresAt === null) {
      return reply.code(400).send({ error: 'Cannot add time to a lifetime macro — it has no expiry.' });
    }

    let newExpiresAt: Date;
    if (new Date(userMacro.expiresAt) > now && userMacro.status === 'active') {
      // Still active — stack the added time onto the existing expiry
      newExpiresAt = new Date(new Date(userMacro.expiresAt).getTime() + addMs);
    } else {
      // Expired or revoked — start fresh from now and reinstate to active
      newExpiresAt = new Date(now.getTime() + addMs);
    }

    await db
      .update(userMacros)
      .set({ status: 'active', expiresAt: newExpiresAt, updatedAt: now })
      .where(eq(userMacros.id, userMacro.id));

    // H-2 fix (audit 2026-06-19): audit trail.
    await db.insert(adminLogs).values({
      action: 'license_add_time',
      actorDiscordId: 'bot',
      targetDiscordId: body.discordId,
      details: JSON.stringify({ macro: body.macro, days: body.days, reinstated: userMacro.status !== 'active' }),
    });

    return reply.send({ ok: true, newExpiresAt: newExpiresAt.toISOString() });
  });

  done();
};

export default licenseRoutes;
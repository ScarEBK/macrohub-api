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
        console.error('[DB INSERT ERROR]', err);
        const msg = err?.message || String(err);
        return reply.code(500).send({ error: `Database insert failed: ${msg}` });
      }

      return reply.send({ keys });
    } catch (err: any) {
      console.error('[GENERATE ERROR]', err);
      return reply.code(500).send({ error: err?.message || String(err) });
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
      return reply.code(403).send({ error: 'KEY_BANNED' });
    }

    if (licenseKey.status === 'redeemed') {
      return reply.code(409).send({ error: 'KEY_ALREADY_REDEEMED' });
    }

    // Verify HWID: session's hwid must match the user's hwid (or user has hwidResetAllowed)
    const [user] = await db
      .select({
        hwid: users.hwid,
        hwidResetAllowed: users.hwidResetAllowed,
      })
      .from(users)
      .where(eq(users.discordId, discordId))
      .limit(1);

    if (user && user.hwid && user.hwid !== hwid && !user.hwidResetAllowed) {
      return reply.code(403).send({ error: 'HWID mismatch. Contact support for a reset.' });
    }

    // Mark key as redeemed
    const now = new Date();
    await db
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

    // Upsert userMacro: if active macro exists, extend; otherwise create new
    const [existingMacro] = await db
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
      if (durationMs === null) {
        // Lifetime — no expiry
        expiresAt = null;
        expiresAtMs = null;
      } else {
        const baseDate = existingMacro.expiresAt && new Date(existingMacro.expiresAt) > now
          ? new Date(existingMacro.expiresAt)
          : now;
        expiresAt = new Date(baseDate.getTime() + durationMs);
        expiresAtMs = expiresAt.getTime();
      }

      await db
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

      await db
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
    await db
      .insert(adminLogs)
      .values({
        action: 'license_redeem',
        actorDiscordId: discordId,
        targetDiscordId: discordId,
        details: JSON.stringify({ key: licenseKey.key, macro, duration }),
      });

    return reply.send({
      success: true,
      macro,
      duration,
      expiresAt: expiresAtMs,
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

    // If key was redeemed, revoke the corresponding userMacro
    if (licenseKey.redeemedBy) {
      await db
        .update(userMacros)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(and(
          eq(userMacros.discordId, licenseKey.redeemedBy),
          eq(userMacros.macro, licenseKey.macro),
        ));
    }

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

    // If there was a revoked userMacro, restore it to 'active'
    if (licenseKey.redeemedBy) {
      const [revokedMacro] = await db
        .select()
        .from(userMacros)
        .where(and(
          eq(userMacros.discordId, licenseKey.redeemedBy),
          eq(userMacros.macro, licenseKey.macro),
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
        }
      }
    }

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

    return reply.send({ ok: true });
  });

  // ── POST /licenses/add-time ───────────────────────────────────────────────
  app.post('/licenses/add-time', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { discordId?: string; macro?: string; days?: number };

    if (!body?.discordId || !body?.macro || !body?.days || typeof body.days !== 'number') {
      return reply.code(400).send({ error: 'Missing or invalid fields: discordId, macro, days' });
    }

    const [userMacro] = await db
      .select()
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, body.discordId),
        eq(userMacros.macro, body.macro),
        eq(userMacros.status, 'active'),
      ))
      .limit(1);

    if (!userMacro) {
      return reply.code(404).send({ error: 'No active macro found for this user' });
    }

    const now = new Date();
    const addMs = body.days * 24 * 60 * 60 * 1000;

    let newExpiresAt: Date;
    if (userMacro.expiresAt && new Date(userMacro.expiresAt) > now) {
      newExpiresAt = new Date(new Date(userMacro.expiresAt).getTime() + addMs);
    } else {
      newExpiresAt = new Date(now.getTime() + addMs);
    }

    await db
      .update(userMacros)
      .set({ expiresAt: newExpiresAt, updatedAt: now })
      .where(eq(userMacros.id, userMacro.id));

    return reply.send({ ok: true, newExpiresAt: newExpiresAt.toISOString() });
  });

  done();
};

export default licenseRoutes;
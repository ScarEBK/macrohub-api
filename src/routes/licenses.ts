import { FastifyPluginCallback } from 'fastify';
import { adminAuth, desktopSessionAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { generateLicenseKey, normalizeLicenseKey } from '../lib/crypto.js';

const VALID_MACROS = ['Speed Boost', 'Glitch Roll', 'Strafe'] as const;
const VALID_DURATIONS = ['1d', '7d', '1m', 'lifetime'] as const;

const DURATION_MS: Record<string, number | null> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  lifetime: null,
};

const licenseRoutes: FastifyPluginCallback = (app, _opts, done) => {
  // ── GET /licenses/ping ────────────────────────────────────────────────────
  app.get('/licenses/ping', async (_request, reply) => {
    return reply.send({ ok: true });
  });

  // ── POST /licenses/generate ───────────────────────────────────────────────
  app.post('/licenses/generate', { preHandler: adminAuth }, async (request, reply) => {
    const body = request.body as { macro?: string; duration?: string; count?: number };

    if (!body?.macro || !VALID_MACROS.includes(body.macro as any)) {
      return reply.code(400).send({ error: 'Invalid macro. Must be one of: ' + VALID_MACROS.join(', ') });
    }

    if (!body?.duration || !VALID_DURATIONS.includes(body.duration as any)) {
      return reply.code(400).send({ error: 'Invalid duration. Must be one of: ' + VALID_DURATIONS.join(', ') });
    }

    if (!body?.count || typeof body.count !== 'number' || body.count < 1 || body.count > 500) {
      return reply.code(400).send({ error: 'Invalid count. Must be between 1 and 500.' });
    }

    const { db } = request.server;
    const { macro, duration, count } = body;
    const keys: string[] = [];

    for (let i = 0; i < count; i++) {
      keys.push(generateLicenseKey());
    }

    const values = keys.map((key) => ({
      key,
      macro,
      duration,
      status: 'available',
    }));

    await db.insertInto('licenseKeys').values(values).execute();

    return reply.send({ keys });
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
      const found = await db
        .selectFrom('licenseKeys')
        .selectAll()
        .where('key', '=', fmt)
        .executeTakeFirst();
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
    const user = await db
      .selectFrom('users')
      .select(['hwid', 'hwidResetAllowed'])
      .where('discordId', '=', discordId)
      .executeTakeFirst();

    if (user && user.hwid && user.hwid !== hwid && !user.hwidResetAllowed) {
      return reply.code(403).send({ error: 'HWID mismatch. Contact support for a reset.' });
    }

    // Mark key as redeemed
    const now = new Date();
    await db
      .updateTable('licenseKeys')
      .set({
        status: 'redeemed',
        discordId,
        redeemedAt: now,
      })
      .where('id', '=', licenseKey.id)
      .execute();

    // Calculate duration
    const durationMs = DURATION_MS[licenseKey.duration];
    const macro = licenseKey.macro;
    const duration = licenseKey.duration;

    // Upsert userMacro: if active macro exists, extend; otherwise create new
    const existingMacro = await db
      .selectFrom('userMacros')
      .selectAll()
      .where('discordId', '=', discordId)
      .where('macro', '=', macro)
      .executeTakeFirst();

    let expiresAt: Date | null;

    if (existingMacro) {
      if (durationMs === null) {
        // Lifetime — no expiry
        expiresAt = null;
      } else {
        const baseDate = existingMacro.expiresAt && new Date(existingMacro.expiresAt) > now
          ? new Date(existingMacro.expiresAt)
          : now;
        expiresAt = new Date(baseDate.getTime() + durationMs);
      }

      await db
        .updateTable('userMacros')
        .set({
          status: 'active',
          source: 'redeem',
          duration,
          expiresAt,
          updatedAt: now,
        })
        .where('id', '=', existingMacro.id)
        .execute();
    } else {
      if (durationMs === null) {
        expiresAt = null;
      } else {
        expiresAt = new Date(now.getTime() + durationMs);
      }

      await db
        .insertInto('userMacros')
        .values({
          discordId,
          macro,
          status: 'active',
          source: 'redeem',
          duration,
          expiresAt,
          licenseKeyId: licenseKey.id,
        })
        .execute();
    }

    // Create adminLog entry
    await db
      .insertInto('adminLogs')
      .values({
        action: 'license_redeem',
        actorDiscordId: discordId,
        targetDiscordId: discordId,
        details: JSON.stringify({ key: licenseKey.key, macro, duration }),
      })
      .execute();

    return reply.send({
      success: true,
      macro,
      duration,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  });

  // ── POST /licenses/access ─────────────────────────────────────────────────
  app.post('/licenses/access', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId } = (request as AuthenticatedRequest).session;
    const { db } = request.server;
    const now = new Date();

    const macros = await db
      .selectFrom('userMacros')
      .selectAll()
      .where('discordId', '=', discordId)
      .execute();

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
        expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
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
      const found = await db
        .selectFrom('licenseKeys')
        .selectAll()
        .where('key', '=', fmt)
        .executeTakeFirst();
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
      .updateTable('licenseKeys')
      .set({ status: 'banned' })
      .where('id', '=', licenseKey.id)
      .execute();

    // If key was redeemed, revoke the corresponding userMacro
    if (licenseKey.discordId) {
      await db
        .updateTable('userMacros')
        .set({ status: 'revoked', updatedAt: new Date() })
        .where('discordId', '=', licenseKey.discordId)
        .where('macro', '=', licenseKey.macro)
        .execute();
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
      const found = await db
        .selectFrom('licenseKeys')
        .selectAll()
        .where('key', '=', fmt)
        .executeTakeFirst();
      if (found) {
        licenseKey = found;
        break;
      }
    }

    if (!licenseKey) {
      return reply.code(404).send({ error: 'KEY_NOT_FOUND' });
    }

    // Restore key status: 'available' if not previously redeemed, 'redeemed' if was redeemed
    const newStatus = licenseKey.discordId ? 'redeemed' : 'available';

    await db
      .updateTable('licenseKeys')
      .set({ status: newStatus })
      .where('id', '=', licenseKey.id)
      .execute();

    // If there was a revoked userMacro, restore it to 'active'
    if (licenseKey.discordId) {
      const revokedMacro = await db
        .selectFrom('userMacros')
        .selectAll()
        .where('discordId', '=', licenseKey.discordId)
        .where('macro', '=', licenseKey.macro)
        .where('status', '=', 'revoked')
        .executeTakeFirst();

      if (revokedMacro) {
        await db
          .updateTable('userMacros')
          .set({ status: 'active', updatedAt: new Date() })
          .where('id', '=', revokedMacro.id)
          .execute();
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
      .updateTable('userMacros')
      .set({ status: 'revoked', updatedAt: new Date() })
      .where('discordId', '=', body.discordId)
      .where('macro', '=', body.macro)
      .execute();

    return reply.send({ ok: true });
  });

  // ── POST /licenses/add-time ───────────────────────────────────────────────
  app.post('/licenses/add-time', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { discordId?: string; macro?: string; days?: number };

    if (!body?.discordId || !body?.macro || !body?.days || typeof body.days !== 'number') {
      return reply.code(400).send({ error: 'Missing or invalid fields: discordId, macro, days' });
    }

    const userMacro = await db
      .selectFrom('userMacros')
      .selectAll()
      .where('discordId', '=', body.discordId)
      .where('macro', '=', body.macro)
      .where('status', '=', 'active')
      .executeTakeFirst();

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
      .updateTable('userMacros')
      .set({ expiresAt: newExpiresAt, updatedAt: now })
      .where('id', '=', userMacro.id)
      .execute();

    return reply.send({ ok: true, newExpiresAt: newExpiresAt.toISOString() });
  });

  done();
};

export default licenseRoutes;
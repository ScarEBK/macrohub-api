import { FastifyPluginCallback } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { desktopSessionAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { userMacros, trialRegistrations } from '../db/schema.js';

const TRIAL_MS = 24 * 60 * 60 * 1000;

const VALID_MACROS = ['Speed Boost', 'Glitch Roll', 'Strafe'] as const;

const trialRoutes: FastifyPluginCallback = (app, _opts, done) => {
  // ── GET /trials/offer ────────────────────────────────────────────────────
  app.get('/trials/offer', { preHandler: [desktopSessionAuth] }, async (request, reply) => {
    const { discordId, hwid } = (request as AuthenticatedRequest).session;
    const { db } = request.server;

    // Check if this HWID already used a trial
    const [existingReg] = await db
      .select({ id: trialRegistrations.id })
      .from(trialRegistrations)
      .where(eq(trialRegistrations.hwid, hwid))
      .limit(1);

    if (existingReg) {
      return reply.send({
        eligible: false,
        reason: 'HWID_ALREADY_USED',
      });
    }

    return reply.send({ eligible: true });
  });

  // ── POST /trials/claim ──────────────────────────────────────────────────
  app.post('/trials/claim', { preHandler: [desktopSessionAuth] }, async (request, reply) => {
    const { discordId, hwid } = (request as AuthenticatedRequest).session;
    const { db } = request.server;
    const body = request.body as {
      macro?: string;
      discordUsername?: string;
      email?: string;
      interestReason?: string;
    };

    if (!body?.macro || !VALID_MACROS.includes(body.macro as any)) {
      return reply.code(400).send({ error: 'Invalid macro. Must be one of: ' + VALID_MACROS.join(', ') });
    }

    const macro = body.macro;
    const email = (body.email ?? '').trim().toLowerCase();
    const interestReason = (body.interestReason ?? '').trim();

    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'Enter a valid email address.' });
    }

    if (interestReason.length < 8) {
      return reply.code(400).send({ error: 'Tell us a bit more about why you want to try MacroHub.' });
    }

    // Check if HWID already used a trial
    const [existingReg] = await db
      .select({ id: trialRegistrations.id })
      .from(trialRegistrations)
      .where(eq(trialRegistrations.hwid, hwid))
      .limit(1);

    if (existingReg) {
      return reply.code(403).send({
        error: 'This PC already used the 24-hour free trial (even with another Discord account).',
      });
    }

    // Check if user already has active access to this macro
    const [existingMacro] = await db
      .select({ id: userMacros.id, status: userMacros.status, expiresAt: userMacros.expiresAt })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, discordId),
        eq(userMacros.macro, macro),
      ))
      .limit(1);

    const now = new Date();
    if (existingMacro) {
      const hasLifetime = existingMacro.expiresAt === null;
      const stillActive = existingMacro.status === 'active' && (!existingMacro.expiresAt || new Date(existingMacro.expiresAt) > now);
      if (hasLifetime || stillActive) {
        return reply.code(403).send({
          error: 'You already have access to this macro — no trial needed.',
        });
      }
    }

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + TRIAL_MS);

    // Create trial registration — persist the collected PII (email,
    // interestReason, discordUsername) so the validation above isn't dead.
    // The columns already exist in the schema; the previous insert omitted
    // them, so the data was validated then discarded.
    await db.insert(trialRegistrations).values({
      discordId,
      discordUsername: body.discordUsername ?? null,
      email,
      interestReason,
      hwid,
      macro,
      startedAt,
      expiresAt,
    });

    // Create or update user macro
    if (existingMacro) {
      await db
        .update(userMacros)
        .set({
          status: 'active',
          source: 'trial',
          duration: '1d',
          expiresAt,
          updatedAt: now,
        })
        .where(eq(userMacros.id, existingMacro.id));
    } else {
      await db.insert(userMacros).values({
        discordId,
        macro,
        status: 'active',
        source: 'trial',
        duration: '1d',
        expiresAt,
      });
    }

    return reply.send({
      success: true,
      macro,
      expiresAt: expiresAt.getTime(),
    });
  });

  // ── POST /trials/dismiss ────────────────────────────────────────────────
  app.post('/trials/dismiss', { preHandler: [desktopSessionAuth] }, async (request, reply) => {
    return reply.send({ ok: true });
  });

  done();
};

export default trialRoutes;
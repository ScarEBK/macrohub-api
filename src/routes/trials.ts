import { FastifyPluginCallback } from 'fastify';
import { eq, and, ne } from 'drizzle-orm';
import { desktopSessionAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { userMacros, trialRegistrations } from '../db/schema.js';

const trialRoutes: FastifyPluginCallback = (app, _opts, done) => {
  // ── GET /trials/offer ────────────────────────────────────────────────────
  app.get('/trials/offer', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId, hwid } = (request as AuthenticatedRequest).session;
    const { db } = request.server;

    // 1. User must have at least 1 paid (non-trial) active macro
    const paidMacros = await db
      .select({ macro: userMacros.macro })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, discordId),
        eq(userMacros.status, 'active'),
        ne(userMacros.source, 'trial'),
      ));

    if (paidMacros.length === 0) {
      return reply.send({
        eligible: false,
        reason: 'You need at least one active paid macro to be eligible for a trial.',
        availableMacros: [],
      });
    }

    // 2. User's HWID must not have any trialRegistrations
    const [existingTrialReg] = await db
      .select({ id: trialRegistrations.id })
      .from(trialRegistrations)
      .where(eq(trialRegistrations.hwid, hwid))
      .limit(1);

    if (existingTrialReg) {
      return reply.send({
        eligible: false,
        reason: 'This device has already been used for a trial.',
        availableMacros: [],
      });
    }

    // 3. Can only trial macros they don't already have active access to
    const activeMacros = await db
      .select({ macro: userMacros.macro })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, discordId),
        eq(userMacros.status, 'active'),
      ));

    const activeMacroNames = new Set(activeMacros.map((m) => m.macro));
    const paidMacroNames = paidMacros.map((m) => m.macro);
    const availableMacros = paidMacroNames.filter((m) => !activeMacroNames.has(m));

    if (availableMacros.length === 0) {
      return reply.send({
        eligible: false,
        reason: 'You already have active access to all available macros.',
        availableMacros: [],
      });
    }

    return reply.send({
      eligible: true,
      availableMacros,
    });
  });

  // ── POST /trials/claim ──────────────────────────────────────────────────
  app.post('/trials/claim', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId, hwid } = (request as AuthenticatedRequest).session;
    const { db } = request.server;
    const body = request.body as { macro?: string };

    if (!body?.macro) {
      return reply.code(400).send({ error: 'Missing macro field' });
    }

    const macro = body.macro;

    // Re-verify eligibility (same checks as offer)

    // 1. Must have at least 1 paid active macro
    const paidMacros = await db
      .select({ macro: userMacros.macro })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, discordId),
        eq(userMacros.status, 'active'),
        ne(userMacros.source, 'trial'),
      ));

    if (paidMacros.length === 0) {
      return reply.code(403).send({ error: 'Not eligible: no active paid macros.' });
    }

    // 2. HWID must not have trial registrations
    const [existingTrialReg] = await db
      .select({ id: trialRegistrations.id })
      .from(trialRegistrations)
      .where(eq(trialRegistrations.hwid, hwid))
      .limit(1);

    if (existingTrialReg) {
      return reply.code(403).send({ error: 'Not eligible: device already used for a trial.' });
    }

    // 3. Must not already have active access to this macro
    const [existingAccess] = await db
      .select({ id: userMacros.id })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, discordId),
        eq(userMacros.macro, macro),
        eq(userMacros.status, 'active'),
      ))
      .limit(1);

    if (existingAccess) {
      return reply.code(403).send({ error: 'Not eligible: you already have active access to this macro.' });
    }

    // 4. Requested macro must be one of the user's paid macros
    const paidMacroNames = paidMacros.map((m) => m.macro);
    if (!paidMacroNames.includes(macro)) {
      return reply.code(400).send({ error: 'Invalid macro for trial.' });
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Create trialRegistration record
    await db
      .insert(trialRegistrations)
      .values({
        discordId,
        hwid,
        macro,
      });

    // Create userMacro with trial source
    await db
      .insert(userMacros)
      .values({
        discordId,
        macro,
        status: 'active',
        source: 'trial',
        duration: '1d',
        expiresAt,
      });

    return reply.send({
      success: true,
      macro,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // ── POST /trials/dismiss ────────────────────────────────────────────────
  app.post('/trials/dismiss', { preHandler: desktopSessionAuth }, async (request, reply) => {
    // Dismissal is client-side only (stored in Electron's ui-preferences).
    // This endpoint exists for future server-side tracking if needed.
    return reply.send({ ok: true });
  });

  done();
};

export default trialRoutes;
import { FastifyPluginCallback } from 'fastify';
import { eq, and, gte } from 'drizzle-orm';
import { desktopSessionAuth, AuthenticatedRequest, adminAuth } from '../middleware/auth.js';
import { generateReferralCode } from '../lib/crypto.js';
import { referralCodes, referralEvents, userMacros } from '../db/schema.js';

const referralRoutes: FastifyPluginCallback = (app, _opts, done) => {
  // ── GET /referrals/my-info ───────────────────────────────────────────────
  app.get('/referrals/my-info', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId } = (request as AuthenticatedRequest).session;
    const { db } = request.server;

    // Look up or create referral code
    const [referralCode] = await db
      .select({ code: referralCodes.code })
      .from(referralCodes)
      .where(eq(referralCodes.discordId, discordId))
      .limit(1);

    if (!referralCode) {
      const code = generateReferralCode(discordId);
      await db
        .insert(referralCodes)
        .values({ discordId, code });
    }

    const codeResult = referralCode ?? { code: generateReferralCode(discordId) };

    // Count install referral events (last 30 days, max 10/month for reward)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const installEvents = await db
      .select({ referredDiscordId: referralEvents.referredDiscordId })
      .from(referralEvents)
      .where(and(
        eq(referralEvents.referrerDiscordId, discordId),
        eq(referralEvents.eventType, 'install'),
        gte(referralEvents.createdAt, thirtyDaysAgo),
      ));

    // Deduplicate by referredDiscordId for install count
    const uniqueReferred = new Set(installEvents.map((e) => e.referredDiscordId));
    const installCount = Math.min(uniqueReferred.size, 10);

    // Count purchase referral events
    const purchaseEvents = await db
      .select({ id: referralEvents.id })
      .from(referralEvents)
      .where(and(
        eq(referralEvents.referrerDiscordId, discordId),
        eq(referralEvents.eventType, 'purchase'),
      ));

    const purchaseCount = purchaseEvents.length;

    // Get referrer's active macros count
    const activeMacros = await db
      .select({ macro: userMacros.macro })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, discordId),
        eq(userMacros.status, 'active'),
      ));

    const activeMacroCount = activeMacros.length;

    // Calculate reward days
    // Install: 3 days per install per active macro (capped at 10 installs)
    // Purchase: varies by duration per purchase per active macro
    let rewardDays = installCount * 3 * activeMacroCount;

    // Add purchase rewards based on duration
    const purchaseDetails = await db
      .select({ duration: referralEvents.duration })
      .from(referralEvents)
      .where(and(
        eq(referralEvents.referrerDiscordId, discordId),
        eq(referralEvents.eventType, 'purchase'),
      ));

    for (const purchase of purchaseDetails) {
      const duration = purchase.duration;
      let days = 2;
      if (duration === '7d') {
        days = 2;
      } else if (duration === '1m') {
        days = 5;
      } else if (duration === 'lifetime') {
        days = 7;
      }
      rewardDays += days * activeMacroCount;
    }

    return reply.send({
      code: codeResult.code,
      installCount,
      purchaseCount,
      rewardDays,
    });
  });

  // ── POST /referrals/ensure-code ──────────────────────────────────────────
  app.post('/referrals/ensure-code', { preHandler: desktopSessionAuth }, async (request, reply) => {
    const { discordId } = (request as AuthenticatedRequest).session;
    const { db } = request.server;

    const [referralCode] = await db
      .select({ code: referralCodes.code })
      .from(referralCodes)
      .where(eq(referralCodes.discordId, discordId))
      .limit(1);

    if (!referralCode) {
      const code = generateReferralCode(discordId);
      await db
        .insert(referralCodes)
        .values({ discordId, code });
      return reply.send({ code });
    }

    return reply.send({ code: referralCode.code });
  });

  // ── POST /referrals/apply-install-reward ─────────────────────────────────
  app.post('/referrals/apply-install-reward', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as { referrerDiscordId?: string; referredDiscordId?: string };

    if (!body?.referrerDiscordId || !body?.referredDiscordId) {
      return reply.code(400).send({ error: 'Missing referrerDiscordId or referredDiscordId' });
    }

    const { referrerDiscordId, referredDiscordId } = body;

    // Dedup: check if this install referral already exists
    const [existing] = await db
      .select({ id: referralEvents.id })
      .from(referralEvents)
      .where(and(
        eq(referralEvents.referrerDiscordId, referrerDiscordId),
        eq(referralEvents.referredDiscordId, referredDiscordId),
        eq(referralEvents.eventType, 'install'),
      ))
      .limit(1);

    if (existing) {
      return reply.code(409).send({ error: 'Install referral already recorded.' });
    }

    // Count how many install referrals the referrer has this month (max 10)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const monthInstalls = await db
      .select({ referredDiscordId: referralEvents.referredDiscordId })
      .from(referralEvents)
      .where(and(
        eq(referralEvents.referrerDiscordId, referrerDiscordId),
        eq(referralEvents.eventType, 'install'),
        gte(referralEvents.createdAt, thirtyDaysAgo),
      ));

    const uniqueMonthInstalls = new Set(monthInstalls.map((e) => e.referredDiscordId));
    if (uniqueMonthInstalls.size >= 10) {
      return reply.code(409).send({ error: 'Monthly install referral limit reached (10).' });
    }

    // Get referrer's active macros
    const activeMacros = await db
      .select({
        macro: userMacros.macro,
        id: userMacros.id,
        expiresAt: userMacros.expiresAt,
      })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, referrerDiscordId),
        eq(userMacros.status, 'active'),
      ));

    // For each active macro, add 3 days
    const daysPerMacro = 3;
    let daysAwarded = 0;

    for (const macro of activeMacros) {
      if (macro.expiresAt) {
        const newExpiry = new Date(macro.expiresAt.getTime() + daysPerMacro * 24 * 60 * 60 * 1000);
        await db
          .update(userMacros)
          .set({ expiresAt: newExpiry, updatedAt: new Date() })
          .where(eq(userMacros.id, macro.id));
      }
      daysAwarded += daysPerMacro;
    }

    // Create referralEvent
    await db
      .insert(referralEvents)
      .values({
        referrerDiscordId,
        referredDiscordId,
        eventType: 'install',
        daysAwarded,
      });

    return reply.send({ ok: true, daysAwarded });
  });

  // ── POST /referrals/apply-purchase-reward ────────────────────────────────
  app.post('/referrals/apply-purchase-reward', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;
    const body = request.body as {
      referrerDiscordId?: string;
      referredDiscordId?: string;
      orderId?: string;
      macro?: string;
      duration?: string;
    };

    if (!body?.referrerDiscordId || !body?.referredDiscordId || !body?.orderId || !body?.macro || !body?.duration) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const { referrerDiscordId, referredDiscordId, orderId, macro, duration } = body;

    // Dedup by orderId
    const [existing] = await db
      .select({ id: referralEvents.id })
      .from(referralEvents)
      .where(eq(referralEvents.orderId, orderId))
      .limit(1);

    if (existing) {
      return reply.code(409).send({ error: 'Purchase referral already recorded for this order.' });
    }

    // Calculate reward days based on duration
    let daysPerMacro: number;
    if (duration === '7d') {
      daysPerMacro = 2;
    } else if (duration === '1m') {
      daysPerMacro = 5;
    } else if (duration === 'lifetime') {
      daysPerMacro = 7;
    } else {
      daysPerMacro = 2; // default fallback
    }

    // Get referrer's active macros
    const activeMacros = await db
      .select({
        macro: userMacros.macro,
        id: userMacros.id,
        expiresAt: userMacros.expiresAt,
      })
      .from(userMacros)
      .where(and(
        eq(userMacros.discordId, referrerDiscordId),
        eq(userMacros.status, 'active'),
      ));

    let daysAwarded = 0;

    for (const activeMacro of activeMacros) {
      if (activeMacro.expiresAt) {
        const newExpiry = new Date(activeMacro.expiresAt.getTime() + daysPerMacro * 24 * 60 * 60 * 1000);
        await db
          .update(userMacros)
          .set({ expiresAt: newExpiry, updatedAt: new Date() })
          .where(eq(userMacros.id, activeMacro.id));
      }
      daysAwarded += daysPerMacro;
    }

    // Create referralEvent
    await db
      .insert(referralEvents)
      .values({
        referrerDiscordId,
        referredDiscordId,
        eventType: 'purchase',
        orderId,
        macroName: macro,
        duration,
        daysAwarded,
      });

    return reply.send({ ok: true, daysAwarded });
  });

  done();
};

export default referralRoutes;
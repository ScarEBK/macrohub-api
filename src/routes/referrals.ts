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
    const [existingCode] = await db
      .select({ code: referralCodes.code })
      .from(referralCodes)
      .where(eq(referralCodes.discordId, discordId))
      .limit(1);

    // Use the code that was actually inserted (not a freshly-generated one
    // that differs from what's in the DB — the previous version generated
    // `code`, inserted it, then returned a DIFFERENT generated code, so the
    // user saw a referral code that didn't match what was stored).
    const code = existingCode?.code ?? generateReferralCode(discordId);
    if (!existingCode) {
      await db
        .insert(referralCodes)
        .values({ discordId, code });
    }

    const codeResult = { code };

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

    // Fetch purchase referral events for reward calculation
    const purchaseDetails = await db
      .select({ duration: referralEvents.duration })
      .from(referralEvents)
      .where(and(
        eq(referralEvents.referrerDiscordId, discordId),
        eq(referralEvents.eventType, 'purchase'),
      ));

    // Calculate purchase rewards by duration tier
    const purchaseRewards = { week: 0, month: 0, lifetime: 0 };
    for (const purchase of purchaseDetails) {
      const duration = purchase.duration;
      if (duration === '7d') {
        purchaseRewards.week++;
      } else if (duration === '1m') {
        purchaseRewards.month++;
      } else if (duration === 'lifetime') {
        purchaseRewards.lifetime++;
      }
    }

    return reply.send({
      code: codeResult.code,
      linkHint: `https://motionlife.mysellauth.com?ref=${codeResult.code}`,
      installRewardDays: 3,
      purchaseRewards,
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
        // Defensive wrap: drizzle/postgres-js may return expiresAt as a string
        // instead of a Date depending on serialization config. new Date(...)
        // accepts both and the previous raw .getTime() would throw TypeError
        // on a string, 500ing the whole reward call.
        const currentExpiry = new Date(macro.expiresAt as any);
        const newExpiry = new Date(currentExpiry.getTime() + daysPerMacro * 24 * 60 * 60 * 1000);
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
        const currentExpiry = new Date(activeMacro.expiresAt as any);
        const newExpiry = new Date(currentExpiry.getTime() + daysPerMacro * 24 * 60 * 60 * 1000);
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
import { FastifyPluginCallback } from 'fastify';
import { eq, count, sql } from 'drizzle-orm';
import { users, userMacros, licenseKeys, referralEvents, referralCodes, trials } from '../db/schema.js';
import { adminAuth } from '../middleware/auth.js';

const adminRoutes: FastifyPluginCallback = (app, _opts, done) => {
  // ── POST /admin/verify ──────────────────────────────────────────────────
  app.post('/admin/verify', { preHandler: adminAuth }, async (_request, reply) => {
    return reply.send({ ok: true });
  });

  // ── GET /admin/user/:discordId ──────────────────────────────────────────
  app.get<{ Params: { discordId: string } }>(
    '/admin/user/:discordId',
    { preHandler: adminAuth },
    async (request, reply) => {
      const { discordId } = request.params;
      const { db } = request.server;

      const user = await db
        .select()
        .from(users)
        .where(eq(users.discordId, discordId))
        .then((rows: any[]) => rows[0] ?? null);

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const macros = await db
        .select()
        .from(userMacros)
        .where(eq(userMacros.discordId, discordId));

      const referralCode = await db
        .select()
        .from(referralCodes)
        .where(eq(referralCodes.discordId, discordId))
        .then((rows: any[]) => rows[0] ?? null);

      return reply.send({
        user,
        macros,
        referralCode: referralCode?.code ?? null,
      });
    },
  );

  // ── GET /admin/stats ────────────────────────────────────────────────────
  app.get('/admin/stats', { preHandler: adminAuth }, async (request, reply) => {
    const { db } = request.server;

    const [userCount] = await db
      .select({ count: count() })
      .from(users);

    const [activeMacroCount] = await db
      .select({ count: count() })
      .from(userMacros)
      .where(eq(userMacros.status, 'active'));

    const [keysGenerated] = await db
      .select({ count: count() })
      .from(licenseKeys);

    const [keysRedeemed] = await db
      .select({ count: count() })
      .from(licenseKeys)
      .where(eq(licenseKeys.status, 'redeemed'));

    const [trialsClaimed] = await db
      .select({ count: count() })
      .from(trials);

    const [referralEventCount] = await db
      .select({ count: count() })
      .from(referralEvents);

    return reply.send({
      users: userCount.count,
      activeMacros: activeMacroCount.count,
      keysGenerated: keysGenerated.count,
      keysRedeemed: keysRedeemed.count,
      trialsClaimed: trialsClaimed.count,
      referralEvents: referralEventCount.count,
    });
  });

  done();
};

export default adminRoutes;
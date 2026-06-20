import { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { timingSafeEqual } from '../lib/crypto.js';
import { desktopSessions, users } from '../db/schema.js';

export interface AuthenticatedRequest extends FastifyRequest {
  session: {
    discordId: string;
    hwid: string;
  };
}

export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const adminSecret = process.env.ADMIN_SECRET || process.env.CONVEX_ADMIN_SECRET;
  if (!adminSecret) {
    request.log.error('ADMIN_SECRET (or CONVEX_ADMIN_SECRET) env var is not set');
    reply.code(500).send({ error: 'Server misconfiguration' });
    return;
  }

  const provided = request.headers['x-admin-secret'];
  if (typeof provided !== 'string') {
    reply.code(401).send({ error: 'Missing x-admin-secret header' });
    return;
  }

  if (!timingSafeEqual(provided, adminSecret)) {
    reply.code(401).send({ error: 'Invalid admin secret' });
    return;
  }
}

export async function desktopSessionAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.headers['x-session-token'];
  const hwid = request.headers['x-hwid'];

  if (typeof token !== 'string') {
    reply.code(401).send({ error: 'Missing x-session-token header' });
    return;
  }

  if (typeof hwid !== 'string') {
    reply.code(401).send({ error: 'Missing x-hwid header' });
    return;
  }

  const { db } = request.server;

  const [session] = await db
    .select({
      discordId: desktopSessions.discordId,
      hwid: desktopSessions.hwid,
      expiresAt: desktopSessions.expiresAt,
    })
    .from(desktopSessions)
    .where(eq(desktopSessions.token, token))
    .limit(1);

  if (!session) {
    reply.code(401).send({ error: 'Invalid session token' });
    return;
  }

  if (new Date(session.expiresAt) <= new Date()) {
    reply.code(401).send({ error: 'Session expired' });
    return;
  }

  if (session.hwid !== hwid) {
    // C-5 fix (audit 2026-06-19): atomic check-and-consume of the HWID reset
    // grant. Previously this read hwidResetAllowed, then issued two separate
    // non-transactional updates — a concurrent pair of requests (e.g. the
    // 3-min poller racing a redeem) both observed hwidResetAllowed=true, both
    // rebound to their own HWID, and the hwidResetCount increment was a lost
    // update. Now a single conditional UPDATE ... WHERE hwid_reset_allowed =
    // true RETURNING id atomically consumes the grant; we only migrate the
    // session row if exactly one row was updated.
    const consumed = await db
      .update(users)
      .set({
        hwid,
        hwidResetAllowed: false,
        hwidResetCount: sql`${users.hwidResetCount} + 1`,
      })
      .where(and(eq(users.discordId, session.discordId), eq(users.hwidResetAllowed, true)))
      .returning({ id: users.id });

    if (consumed.length === 1) {
      // Grant consumed atomically — now migrate the session row.
      await db
        .update(desktopSessions)
        .set({ hwid })
        .where(eq(desktopSessions.token, token));
    } else {
      // No grant available (either it was never set, or a concurrent request
      // already consumed it). Reject.
      reply.code(401).send({ error: 'HWID mismatch' });
      return;
    }
  }

  (request as AuthenticatedRequest).session = {
    discordId: session.discordId,
    hwid,
  };
}
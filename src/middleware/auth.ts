import { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
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
    // Check if the user has hwidResetAllowed
    const [user] = await db
      .select({ hwidResetAllowed: users.hwidResetAllowed })
      .from(users)
      .where(eq(users.discordId, session.discordId))
      .limit(1);

    if (user?.hwidResetAllowed) {
      await db
        .update(desktopSessions)
        .set({ hwid })
        .where(eq(desktopSessions.token, token));
    } else {
      reply.code(401).send({ error: 'HWID mismatch' });
      return;
    }
  }

  (request as AuthenticatedRequest).session = {
    discordId: session.discordId,
    hwid,
  };
}
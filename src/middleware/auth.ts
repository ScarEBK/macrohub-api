import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from '../lib/crypto.js';

export interface AuthenticatedRequest extends FastifyRequest {
  session: {
    discordId: string;
    hwid: string;
  };
}

export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    request.log.error('ADMIN_SECRET env var is not set');
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

  const session = await db
    .selectFrom('desktopSessions')
    .select(['discordId', 'hwid', 'expiresAt', 'hwidResetAllowed'])
    .where('token', '=', token)
    .executeTakeFirst();

  if (!session) {
    reply.code(401).send({ error: 'Invalid session token' });
    return;
  }

  if (new Date(session.expiresAt) <= new Date()) {
    reply.code(401).send({ error: 'Session expired' });
    return;
  }

  if (session.hwid !== hwid) {
    if (session.hwidResetAllowed) {
      await db
        .updateTable('desktopSessions')
        .set({ hwid })
        .where('token', '=', token)
        .execute();
    } else {
      reply.code(401).send({ error: 'HWID mismatch' });
      return;
    }
  }

  (request as AuthenticatedRequest).session = {
    discordId: session.discordId,
    hwid: session.hwidResetAllowed && session.hwid !== hwid ? hwid : session.hwid,
  };
}
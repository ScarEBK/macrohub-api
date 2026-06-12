import { FastifyPluginCallback } from 'fastify';
import { desc, sql } from 'drizzle-orm';
import { clientReports, desktopSessions } from '../db/schema.js';
import { adminAuth } from '../middleware/auth.js';

const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 2000;

interface SubmitBody {
  type: 'error' | 'warning';
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

const reportPlugin: FastifyPluginCallback = async (fastify) => {
  const db = fastify.db;

  // ── POST /submit ────────────────────────────────────────────────────────
  fastify.post('/submit', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    // Optional auth — extract session token manually without sending error responses
    let discordId: string | null = null;

    const token = request.headers['x-session-token'];
    if (typeof token === 'string' && token.length > 0) {
      try {
        const [session] = await db
          .select({ discordId: desktopSessions.discordId })
          .from(desktopSessions)
          .where(sql`${desktopSessions.token} = ${token}`)
          .limit(1);
        if (session) {
          discordId = session.discordId;
        }
      } catch {
        // Session lookup failed — proceed as anonymous
      }
    }

    const data = request.body as SubmitBody;

    if (!data.type || (data.type !== 'error' && data.type !== 'warning')) {
      reply.code(400).send({ error: 'type must be "error" or "warning"' });
      return;
    }

    if (!data.message || typeof data.message !== 'string') {
      reply.code(400).send({ error: 'message is required' });
      return;
    }

    const truncatedMessage = data.message.slice(0, MAX_MESSAGE_LENGTH);
    const truncatedStack = data.stack ? data.stack.slice(0, MAX_STACK_LENGTH) : null;

    await db.insert(clientReports).values({
      discordId: discordId ?? undefined,
      type: data.type,
      message: truncatedMessage,
      stack: truncatedStack,
      context: data.context ?? undefined,
    });

    // Send to Discord webhook if configured
    const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const embed: Record<string, unknown> = {
          title: `[${data.type.toUpperCase()}] Client Report`,
          description: truncatedMessage.slice(0, 4096),
          color: data.type === 'error' ? 0xff0000 : 0xffaa00,
          timestamp: new Date().toISOString(),
          fields: [],
        };

        const fields = (embed.fields as Array<Record<string, unknown>>);
        if (discordId) {
          fields.push({ name: 'Discord ID', value: discordId, inline: true });
        }
        if (truncatedStack) {
          fields.push({
            name: 'Stack',
            value: truncatedStack.slice(0, 1024),
            inline: false,
          });
        }

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        request.log.warn({ err }, 'Failed to send report to Discord webhook');
      }
    }

    reply.send({ ok: true });
  });

  // ── GET /reports/recent ─────────────────────────────────────────────────
  fastify.get('/reports/recent', async (request, reply) => {
    await adminAuth(request, reply);
    if (reply.sent) return;

    const query = request.query as { days?: string; limit?: string };
    const days = Math.min(Math.max(Number(query.days ?? 7) || 7, 1), 30);
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await db
      .select()
      .from(clientReports)
      .where(sql`${clientReports.createdAt} >= ${cutoff}`)
      .orderBy(desc(clientReports.createdAt))
      .limit(limit);

    reply.send(result);
  });
};

export default reportPlugin;
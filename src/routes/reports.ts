import { FastifyPluginCallback } from 'fastify';
import { eq, desc, sql, gte } from 'drizzle-orm';
import { clientReports, desktopSessions, users } from '../db/schema.js';
import { adminAuth } from '../middleware/auth.js';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 4000;
const MAX_CONTEXT_LENGTH = 2000;

interface SubmitBody {
  severity: 'error' | 'warning';
  message: string;
  stack?: string;
  context?: string;
  route?: string;
  appVersion?: string;
}

const reportPlugin: FastifyPluginCallback = async (fastify) => {
  const db = fastify.db;

  // ── POST /reports/submit ────────────────────────────────────────────────
  fastify.post('/reports/submit', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    // Optional auth — extract session token + hwid
    let discordId: string | null = null;
    let discordUsername: string | null = null;
    let hwidPrefix: string | null = null;

    const token = request.headers['x-session-token'] as string | undefined;
    const hwid = request.headers['x-hwid'] as string | undefined;

    if (hwid) {
      hwidPrefix = hwid.slice(0, 8);
    }

    if (token && token.length > 0) {
      try {
        const [session] = await db
          .select({ discordId: desktopSessions.discordId })
          .from(desktopSessions)
          .where(eq(desktopSessions.token, token))
          .limit(1);
        if (session) {
          discordId = session.discordId;
          const [user] = await db
            .select({ username: users.username })
            .from(users)
            .where(eq(users.discordId, discordId!))
            .limit(1);
          if (user) {
            discordUsername = user.username;
          }
        }
      } catch {
        // Session lookup failed — proceed as anonymous
      }
    }

    const data = request.body as SubmitBody;

    if (!data.severity || (data.severity !== 'error' && data.severity !== 'warning')) {
      reply.code(400).send({ error: 'severity must be "error" or "warning"' });
      return;
    }

    if (!data.message || typeof data.message !== 'string') {
      reply.code(400).send({ error: 'message is required' });
      return;
    }

    const truncatedMessage = data.message.slice(0, MAX_MESSAGE_LENGTH);
    const truncatedStack = data.stack ? data.stack.slice(0, MAX_STACK_LENGTH) : null;
    const truncatedContext = data.context ? data.context.slice(0, MAX_CONTEXT_LENGTH) : null;
    const appVersion = data.appVersion ? data.appVersion.slice(0, 32) : null;
    const route = data.route ? data.route.slice(0, 256) : null;

    await db.insert(clientReports).values({
      discordId: discordId ?? undefined,
      discordUsername: discordUsername ?? undefined,
      appVersion: appVersion ?? undefined,
      hwidPrefix: hwidPrefix ?? 'unknown',
      severity: data.severity,
      message: truncatedMessage,
      stack: truncatedStack,
      context: truncatedContext,
      route: route ?? undefined,
    });

    // Send to Discord webhook if configured
    const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const userLabel = discordUsername
          ? `${discordUsername} (\`${discordId}\`)`
          : discordId
            ? `\`${discordId}\``
            : 'unsigned';

        const lines: string[] = [
          `**User:** ${userLabel}`,
          `**App:** v${appVersion ?? 'unknown'}`,
          `**Route:** ${route ?? '—'}`,
          `**HWID:** \`${hwidPrefix ?? 'unknown'}…\``,
          '',
          `\`\`\`\n${truncatedMessage}\n\`\`\``,
        ];
        if (truncatedContext) {
          lines.push('', '**Context:**', `\`\`\`\n${truncatedContext}\n\`\`\``);
        }
        if (truncatedStack) {
          lines.push('', '**Stack:**', `\`\`\`\n${truncatedStack.slice(0, 1500)}\n\`\`\``);
        }

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: `MacroHub ${data.severity}: ${truncatedMessage.slice(0, 80)}`,
              description: lines.join('\n').slice(0, 4000),
              color: data.severity === 'error' ? 0xed4245 : 0xfaa61a,
              timestamp: new Date().toISOString(),
            }],
          }),
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

    const query = request.query as { sinceMs?: string; limit?: string };
    const since = query.sinceMs ? Number(query.sinceMs) : Date.now() - 7 * 24 * 60 * 60 * 1000;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);

    const cutoff = new Date(since);

    const result = await db
      .select({
        createdAt: clientReports.createdAt,
        severity: clientReports.severity,
        message: clientReports.message,
        discordUsername: clientReports.discordUsername,
        discordId: clientReports.discordId,
        appVersion: clientReports.appVersion,
        route: clientReports.route,
        context: clientReports.context,
      })
      .from(clientReports)
      .where(gte(clientReports.createdAt, cutoff))
      .orderBy(desc(clientReports.createdAt))
      .limit(limit);

    reply.send(result.map((r) => ({
      createdAt: r.createdAt ? new Date(r.createdAt).getTime() : null,
      severity: r.severity,
      message: r.message,
      discordUsername: r.discordUsername,
      discordId: r.discordId,
      appVersion: r.appVersion,
      route: r.route,
      context: r.context,
    })));
  });
};

export default reportPlugin;
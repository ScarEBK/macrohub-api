import { FastifyPluginCallback } from 'fastify';
import { eq, and, lte, gt, isNull, or, desc } from 'drizzle-orm';
import { announcements } from '../db/schema.js';
import { adminAuth } from '../middleware/auth.js';

const VALID_APP_IDS = ['macrohub', 'triggerbot', '5hub'] as const;
const VALID_TYPES = ['info', 'warning', 'promo', 'maintenance'] as const;

type AppId = (typeof VALID_APP_IDS)[number];
type AnnouncementType = (typeof VALID_TYPES)[number];

interface PublishBody {
  appId: string;
  type: string;
  title: string;
  body: string;
  imageUrl?: string;
  dismissible?: boolean;
  endsAt?: string;
  replaceExisting?: boolean;
  actorDiscordId?: string;
}

interface ClearBody {
  appId: string;
  actorDiscordId?: string;
}

const announcementPlugin: FastifyPluginCallback = async (fastify) => {
  const db = fastify.db;

  // ── GET /announcements/active ────────────────────────────────────────────
  fastify.get('/announcements/active', async (request, reply) => {
    const query = request.query as { appId?: string };
    const appId = query.appId ?? 'macrohub';

    if (!VALID_APP_IDS.includes(appId as AppId)) {
      reply.code(400).send({ error: 'Invalid appId' });
      return;
    }

    const now = new Date();

    const result = await db
      .select()
      .from(announcements)
      .where(
        and(
          eq(announcements.appId, appId),
          lte(announcements.startsAt, now),
          or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
        ),
      )
      .orderBy(desc(announcements.startsAt));

    reply.send(result.map((row) => ({
      id: row.id,
      appId: row.appId,
      title: row.title,
      body: row.body,
      type: row.type,
      imageUrl: row.imageUrl,
      dismissible: row.dismissible ?? true,
      startsAt: row.startsAt ? new Date(row.startsAt).getTime() : null,
      endsAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
    })));
  });

  // ── POST /announcements/publish ──────────────────────────────────────────
  fastify.post('/announcements/publish', async (request, reply) => {
    await adminAuth(request, reply);
    if (reply.sent) return;

    const data = request.body as PublishBody;

    if (!VALID_APP_IDS.includes(data.appId as AppId)) {
      reply.code(400).send({ error: 'Invalid appId. Must be one of: macrohub, triggerbot, 5hub' });
      return;
    }

    if (!VALID_TYPES.includes(data.type as AnnouncementType)) {
      reply.code(400).send({ error: 'Invalid type. Must be one of: info, warning, promo, maintenance' });
      return;
    }

    const title = (data.title ?? '').trim();
    const body = (data.body ?? '').trim();
    if (!title || !body) {
      reply.code(400).send({ error: 'title and body are required' });
      return;
    }

    // If replaceExisting (default true), delete all existing announcements for this appId
    const shouldReplace = data.replaceExisting !== false;

    let clearedCount = 0;
    if (shouldReplace) {
      const deleted = await db
        .delete(announcements)
        .where(eq(announcements.appId, data.appId))
        .returning();
      clearedCount = deleted.length;
    }

    const imageUrl = (data.imageUrl ?? '').trim() || null;
    const endsAt = data.endsAt ? new Date(data.endsAt) : null;

    const [created] = await db
      .insert(announcements)
      .values({
        appId: data.appId,
        type: data.type,
        title,
        body,
        imageUrl,
        dismissible: data.dismissible ?? true,
        createdByDiscordId: data.actorDiscordId ?? null,
        startsAt: new Date(),
        expiresAt: endsAt,
      })
      .returning();

    reply.send({
      announcementId: created.id,
      clearedCount,
    });
  });

  // ── POST /announcements/clear ────────────────────────────────────────────
  fastify.post('/announcements/clear', async (request, reply) => {
    await adminAuth(request, reply);
    if (reply.sent) return;

    const data = request.body as ClearBody;

    if (!data.appId) {
      reply.code(400).send({ error: 'appId is required' });
      return;
    }

    const result = await db
      .delete(announcements)
      .where(eq(announcements.appId, data.appId))
      .returning();

    reply.send({ ok: true, deletedCount: result.length });
  });
};

export default announcementPlugin;
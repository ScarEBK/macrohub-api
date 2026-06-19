import { FastifyPluginCallback } from 'fastify';
import { adminAuth } from '../middleware/auth.js';
import {
  users,
  licenseKeys,
  userMacros,
  referralCodes,
  referralEvents,
  trials,
  announcements,
} from '../db/schema.js';

type ConvexDoc = Record<string, unknown>;

interface SnapshotBody {
  users?: ConvexDoc[];
  referralCodes?: ConvexDoc[];
  referralEvents?: ConvexDoc[];
  licenseKeys?: ConvexDoc[];
  userMacros?: ConvexDoc[];
  trials?: ConvexDoc[];
  announcements?: ConvexDoc[];
}

function toDate(ms: unknown): Date | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Bulk Convex-doc import. Rewritten to use Drizzle parameterized inserts
 * inside a single transaction — the previous implementation built raw SQL
 * via `sql.raw` with a single-quote-only `esc()` helper, which is a SQL
 * injection vector (backslashes, null bytes, and other metacharacters were
 * not escaped). Parameterized inserts close that hole entirely.
 */
const importSnapshotRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post<{ Body: SnapshotBody }>(
    '/admin/import-snapshot',
    { preHandler: adminAuth },
    async (request, reply) => {
      const body = request.body ?? {};
      const db = request.server.db;
      const imported: Record<string, number> = {
        users: 0,
        licenseKeys: 0,
        userMacros: 0,
        referralCodes: 0,
        referralEvents: 0,
        trials: 0,
        announcements: 0,
      };

      await db.transaction(async (tx) => {
        for (const u of body.users ?? []) {
          const discordId = str(u.discordId);
          if (!discordId) continue;
          const createdAt = toDate(u.createdAt) ?? new Date();
          const lastSeenAt = toDate(u.lastSeenAt) ?? new Date();
          await tx.insert(users).values({
            discordId,
            username: str(u.username) ?? 'unknown',
            avatarUrl: str(u.avatarUrl),
            hwid: str(u.hwid),
            hwidResetAllowed: u.hwidResetAllowed === true,
            hwidResetCount: num(u.hwidResetCount) ?? 0,
            referredByDiscordId: str(u.referredByDiscordId),
            createdAt,
            updatedAt: new Date(),
            lastSeenAt,
          }).onConflictDoUpdate({
            target: users.discordId,
            set: {
              username: str(u.username) ?? 'unknown',
              avatarUrl: str(u.avatarUrl),
              hwid: str(u.hwid),
              lastSeenAt,
              updatedAt: new Date(),
            },
          });
          imported.users += 1;
        }

        for (const k of body.licenseKeys ?? []) {
          const key = str(k.key);
          if (!key) continue;
          await tx.insert(licenseKeys).values({
            key,
            status: str(k.status) ?? 'available',
            macro: str(k.macro) ?? '',
            duration: str(k.duration) ?? '1d',
            redeemedBy: str(k.redeemedBy),
            sellauthOrderId: str(k.sellauthOrderId),
            createdAt: toDate(k.createdAt) ?? new Date(),
            redeemedAt: toDate(k.redeemedAt),
          }).onConflictDoNothing();
          imported.licenseKeys += 1;
        }

        for (const m of body.userMacros ?? []) {
          const discordId = str(m.discordId);
          const macro = str(m.macro);
          if (!discordId || !macro) continue;
          await tx.insert(userMacros).values({
            discordId,
            macro,
            status: str(m.status) ?? 'active',
            source: str(m.source) ?? 'redeem',
            duration: null,
            expiresAt: toDate(m.expiresAt),
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: [userMacros.discordId, userMacros.macro],
            set: {
              status: str(m.status) ?? 'active',
              expiresAt: toDate(m.expiresAt),
              updatedAt: new Date(),
            },
          });
          imported.userMacros += 1;
        }

        for (const r of body.referralCodes ?? []) {
          const discordId = str(r.discordId);
          const code = str(r.code);
          if (!discordId || !code) continue;
          await tx.insert(referralCodes).values({
            discordId,
            code,
            createdAt: new Date(),
          }).onConflictDoNothing();
          imported.referralCodes += 1;
        }

        for (const e of body.referralEvents ?? []) {
          const referrer = str(e.referrerDiscordId);
          const referred = str(e.referredDiscordId);
          if (!referrer || !referred) continue;
          const eventType = str(e.type ?? e.eventType) ?? 'install';
          const orderId = str(e.orderId);
          const daysAwarded = num(e.daysGrantedPerMacro);
          const createdAt = toDate(e.createdAt) ?? new Date();
          if (orderId) {
            await tx.insert(referralEvents).values({
              referrerDiscordId: referrer,
              referredDiscordId: referred,
              eventType,
              orderId,
              daysAwarded,
              macroName: str(e.macroName) ?? null,
              duration: str(e.duration) ?? null,
              createdAt,
            }).onConflictDoNothing();
          } else {
            await tx.insert(referralEvents).values({
              referrerDiscordId: referrer,
              referredDiscordId: referred,
              eventType,
              daysAwarded,
              macroName: str(e.macroName) ?? null,
              duration: str(e.duration) ?? null,
              createdAt,
            });
          }
          imported.referralEvents += 1;
        }

        for (const t of body.trials ?? []) {
          const discordId = str(t.discordId);
          const macro = str(t.macro);
          if (!discordId || !macro) continue;
          await tx.insert(trials).values({
            discordId,
            macro,
            expiresAt: toDate(t.expiresAt) ?? new Date(),
            createdAt: new Date(),
          }).onConflictDoNothing();
          imported.trials += 1;
        }

        for (const a of body.announcements ?? []) {
          const title = str(a.title);
          if (!title) continue;
          await tx.insert(announcements).values({
            appId: str(a.appId) ?? 'macrohub',
            type: str(a.type) ?? 'info',
            title,
            body: str(a.body) ?? '',
            imageUrl: str(a.imageUrl),
            dismissible: a.dismissible !== false,
            startsAt: toDate(a.startsAt) ?? new Date(),
            expiresAt: toDate(a.endsAt ?? a.expiresAt),
            createdAt: new Date(),
          });
          imported.announcements += 1;
        }
      });

      return reply.send({ ok: true, imported });
    },
  );

  done();
};

export default importSnapshotRoutes;
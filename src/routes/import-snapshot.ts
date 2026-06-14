import { FastifyPluginCallback } from 'fastify';
import { sql } from 'drizzle-orm';
import { adminAuth } from '../middleware/auth.js';

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

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

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

      for (const u of body.users ?? []) {
        const discordId = str(u.discordId);
        if (!discordId) continue;
        await db.execute(sql.raw(`
          INSERT INTO users (discord_id, username, avatar_url, hwid, hwid_reset_allowed, hwid_reset_count, referred_by_discord_id, created_at, updated_at, last_seen_at)
          VALUES (
            '${esc(discordId)}',
            '${esc(String(u.username ?? 'unknown'))}',
            ${u.avatarUrl ? `'${esc(String(u.avatarUrl))}'` : 'NULL'},
            ${u.hwid ? `'${esc(String(u.hwid))}'` : 'NULL'},
            ${u.hwidResetAllowed === true},
            ${typeof u.hwidResetCount === 'number' ? u.hwidResetCount : 0},
            ${u.referredByDiscordId ? `'${esc(String(u.referredByDiscordId))}'` : 'NULL'},
            ${toDate(u.createdAt) ? `'${toDate(u.createdAt)!.toISOString()}'` : 'NOW()'},
            NOW(),
            ${toDate(u.lastSeenAt) ? `'${toDate(u.lastSeenAt)!.toISOString()}'` : 'NOW()'}
          )
          ON CONFLICT (discord_id) DO UPDATE SET
            username = EXCLUDED.username,
            avatar_url = EXCLUDED.avatar_url,
            hwid = COALESCE(EXCLUDED.hwid, users.hwid),
            last_seen_at = EXCLUDED.last_seen_at,
            updated_at = NOW()
        `));
        imported.users += 1;
      }

      for (const k of body.licenseKeys ?? []) {
        const key = str(k.key);
        if (!key) continue;
        await db.execute(sql.raw(`
          INSERT INTO license_keys (key, status, macro, duration, redeemed_by, sellauth_order_id, created_at, redeemed_at)
          VALUES (
            '${esc(key)}',
            '${esc(String(k.status ?? 'available'))}',
            '${esc(String(k.macro ?? ''))}',
            '${esc(String(k.duration ?? '1d'))}',
            ${k.redeemedBy ? `'${esc(String(k.redeemedBy))}'` : 'NULL'},
            ${k.sellauthOrderId ? `'${esc(String(k.sellauthOrderId))}'` : 'NULL'},
            ${toDate(k.createdAt) ? `'${toDate(k.createdAt)!.toISOString()}'` : 'NOW()'},
            ${toDate(k.redeemedAt) ? `'${toDate(k.redeemedAt)!.toISOString()}'` : 'NULL'}
          )
          ON CONFLICT (key) DO NOTHING
        `));
        imported.licenseKeys += 1;
      }

      for (const m of body.userMacros ?? []) {
        const discordId = str(m.discordId);
        const macro = str(m.macro);
        if (!discordId || !macro) continue;
        await db.execute(sql.raw(`
          INSERT INTO user_macros (discord_id, macro, status, source, expires_at, created_at, updated_at)
          VALUES (
            '${esc(discordId)}',
            '${esc(macro)}',
            '${esc(String(m.status ?? 'active'))}',
            '${esc(String(m.source ?? 'redeem'))}',
            ${toDate(m.expiresAt) ? `'${toDate(m.expiresAt)!.toISOString()}'` : 'NULL'},
            NOW(),
            NOW()
          )
          ON CONFLICT (discord_id, macro) DO UPDATE SET
            status = EXCLUDED.status,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `));
        imported.userMacros += 1;
      }

      for (const r of body.referralCodes ?? []) {
        const discordId = str(r.discordId);
        const code = str(r.code);
        if (!discordId || !code) continue;
        await db.execute(sql.raw(`
          INSERT INTO referral_codes (discord_id, code, created_at)
          VALUES ('${esc(discordId)}', '${esc(code)}', NOW())
          ON CONFLICT (discord_id) DO NOTHING
        `));
        imported.referralCodes += 1;
      }

      for (const e of body.referralEvents ?? []) {
        const referrer = str(e.referrerDiscordId);
        const referred = str(e.referredDiscordId);
        if (!referrer || !referred) continue;
        const eventType = str(e.type ?? e.eventType) ?? 'install';
        const orderId = str(e.orderId);
        if (orderId) {
          await db.execute(sql.raw(`
            INSERT INTO referral_events (referrer_discord_id, referred_discord_id, event_type, order_id, days_awarded, created_at)
            VALUES (
              '${esc(referrer)}', '${esc(referred)}', '${esc(eventType)}', '${esc(orderId)}',
              ${typeof e.daysGrantedPerMacro === 'number' ? e.daysGrantedPerMacro : 'NULL'},
              ${toDate(e.createdAt) ? `'${toDate(e.createdAt)!.toISOString()}'` : 'NOW()'}
            )
            ON CONFLICT (order_id) DO NOTHING
          `));
        } else {
          await db.execute(sql.raw(`
            INSERT INTO referral_events (referrer_discord_id, referred_discord_id, event_type, days_awarded, created_at)
            VALUES (
              '${esc(referrer)}', '${esc(referred)}', '${esc(eventType)}',
              ${typeof e.daysGrantedPerMacro === 'number' ? e.daysGrantedPerMacro : 'NULL'},
              ${toDate(e.createdAt) ? `'${toDate(e.createdAt)!.toISOString()}'` : 'NOW()'}
            )
          `));
        }
        imported.referralEvents += 1;
      }

      for (const t of body.trials ?? []) {
        const discordId = str(t.discordId);
        const macro = str(t.macro);
        if (!discordId || !macro) continue;
        await db.execute(sql.raw(`
          INSERT INTO trials (discord_id, macro, expires_at, created_at)
          VALUES (
            '${esc(discordId)}', '${esc(macro)}',
            '${toDate(t.expiresAt)?.toISOString() ?? new Date().toISOString()}',
            NOW()
          )
          ON CONFLICT (discord_id, macro) DO NOTHING
        `));
        imported.trials += 1;
      }

      for (const a of body.announcements ?? []) {
        const title = str(a.title);
        if (!title) continue;
        await db.execute(sql.raw(`
          INSERT INTO announcements (app_id, type, title, body, image_url, dismissible, starts_at, expires_at, created_at)
          VALUES (
            '${esc(str(a.appId) ?? 'macrohub')}',
            '${esc(String(a.type ?? 'info'))}',
            '${esc(title)}',
            '${esc(String(a.body ?? ''))}',
            ${a.imageUrl ? `'${esc(String(a.imageUrl))}'` : 'NULL'},
            ${a.dismissible !== false},
            ${toDate(a.startsAt) ? `'${toDate(a.startsAt)!.toISOString()}'` : 'NOW()'},
            ${toDate(a.endsAt ?? a.expiresAt) ? `'${toDate(a.endsAt ?? a.expiresAt)!.toISOString()}'` : 'NULL'},
            NOW()
          )
        `));
        imported.announcements += 1;
      }

      return reply.send({ ok: true, imported });
    },
  );

  done();
};

export default importSnapshotRoutes;

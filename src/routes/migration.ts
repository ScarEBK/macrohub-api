import { FastifyPluginCallback } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { users, userMacros, migrationClaims } from '../db/schema.js';
import { adminAuth } from '../middleware/auth.js';

const BONUS_DAYS = 7;
const TIMED_ELIGIBILITY_DAYS = 30;

// Duration → milliseconds (lifetime = null expiry).
const DURATION_MS: Record<string, number | null> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'lifetime': null,
};

function calculateMigrationExpiry(duration: string, purchasedAt?: Date): { expiresAt: Date | null; eligible: boolean } {
  const now = new Date();

  if (duration === 'lifetime') {
    return { expiresAt: null, eligible: true };
  }

  // Timed subscriptions: only eligible if purchased within last 30 days
  const purchaseDate = purchasedAt ?? now;
  const daysSincePurchase = (now.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSincePurchase > TIMED_ELIGIBILITY_DAYS) {
    return { expiresAt: null, eligible: false };
  }

  // Remaining time from original purchase + 7-day bonus
  const durationMs = DURATION_MS[duration] ?? (30 * 24 * 60 * 60 * 1000);
  const remainingMs = durationMs - (now.getTime() - purchaseDate.getTime());

  const bonusMs = BONUS_DAYS * 24 * 60 * 60 * 1000;
  const totalMs = Math.max(remainingMs, 0) + bonusMs;

  return { expiresAt: new Date(now.getTime() + totalMs), eligible: true };
}

/**
 * Upsert a userMacro with extend-on-conflict semantics (mirrors /licenses/redeem).
 * - If the macro doesn't exist for this user → insert with the given expiry.
 * - If it exists and is lifetime (expiresAt null) → keep lifetime (no-op).
 * - If it exists and is timed → extend: newExpiry = max(existingExpiry, now) + durationMs.
 * Returns true if a row was inserted or extended.
 */
async function upsertUserMacroExtend(
  db: any,
  discordId: string,
  macro: string,
  duration: string,
  expiresAt: Date | null,
): Promise<boolean> {
  const durationMs = DURATION_MS[duration] ?? (30 * 24 * 60 * 60 * 1000);
  const lifetime = duration === 'lifetime' || expiresAt === null;

  if (lifetime) {
    // Insert-or-keep-lifetime. If a row exists, ensure it stays lifetime.
    const existing = await db.select().from(userMacros)
      .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, macro)))
      .limit(1).then((rows: any[]) => rows[0] ?? null);
    if (existing) {
      // Already owned — if it's currently lifetime, nothing to do; if timed, upgrade to lifetime.
      if (existing.expiresAt === null) return false;
      await db.update(userMacros).set({ expiresAt: null, status: 'active', duration: 'lifetime' })
        .where(eq(userMacros.id, existing.id));
      return true;
    }
    await db.insert(userMacros).values({
      discordId, macro, status: 'active', source: 'migration', duration, expiresAt: undefined,
    });
    return true;
  }

  // Timed: insert-or-extend.
  const now = Date.now();
  const existing = await db.select().from(userMacros)
    .where(and(eq(userMacros.discordId, discordId), eq(userMacros.macro, macro)))
    .limit(1).then((rows: any[]) => rows[0] ?? null);
  if (existing) {
    if (existing.expiresAt === null) return false; // already lifetime, don't downgrade
    const base = Math.max(new Date(existing.expiresAt).getTime(), now);
    const newExpiry = new Date(base + durationMs);
    await db.update(userMacros).set({ expiresAt: newExpiry, status: 'active' })
      .where(eq(userMacros.id, existing.id));
    return true;
  }
  await db.insert(userMacros).values({
    discordId, macro, status: 'active', source: 'migration', duration,
    expiresAt: expiresAt ?? undefined,
  });
  return true;
}

interface ImportPurchaseBody {
  discordId?: string;
  sellauthUsername?: string;
  orderId: string;
  macro: string;
  duration: string;
  sellauthProductId?: number | string;
  sellauthVariantId?: number | string;
}

interface ImportRowBody {
  discordId?: string;
  sellauthUsername?: string;
  orderId: string;
  macro: string;
  duration: string;
  purchasedAt?: string;
}

const migrationPlugin: FastifyPluginCallback = async (fastify) => {
  const db = fastify.db;

  // ── POST /migration/import-purchase ──────────────────────────────────────
  fastify.post('/migration/import-purchase', async (request, reply) => {
    await adminAuth(request, reply);
    if (reply.sent) return;

    const data = request.body as ImportPurchaseBody;

    if (!data.orderId || !data.macro || !data.duration) {
      reply.code(400).send({ error: 'orderId, macro, and duration are required' });
      return;
    }

    // Dedup by orderId
    const existing = await db
      .select()
      .from(migrationClaims)
      .where(eq(migrationClaims.orderId, data.orderId))
      .limit(1)
      .then((rows: any[]) => rows[0] ?? null);

    if (existing) {
      reply.code(409).send({ error: 'Order already imported', id: existing.id });
      return;
    }

    // Also check userMacros for this orderId (via migration source)
    const existingMacro = await db
      .select()
      .from(userMacros)
      .where(
        and(
          eq(userMacros.discordId, data.discordId ?? ''),
          eq(userMacros.macro, data.macro),
        ),
      )
      .limit(1)
      .then((rows: any[]) => rows[0] ?? null);

    const { expiresAt, eligible } = calculateMigrationExpiry(data.duration);

    if (!eligible) {
      reply.send({ ok: true, granted: false, reason: 'Purchase too old for migration' });
      return;
    }

    // If discordId provided and user exists: grant userMacro directly
    if (data.discordId) {
      const user = await db
        .select()
        .from(users)
        .where(eq(users.discordId, data.discordId))
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);

      if (user) {
        // Grant (or extend) the macro — stacking extends the existing expiry.
        if (existingMacro) {
          // Use upsert so a second purchase of the same macro extends, not skips.
          const extended = await upsertUserMacroExtend(db, data.discordId, data.macro, data.duration, expiresAt);
          reply.send({ ok: true, granted: extended, expiresAt, extended });
          return;
        }

        await db.insert(userMacros).values({
          discordId: data.discordId,
          macro: data.macro,
          status: 'active',
          source: 'migration',
          duration: data.duration,
          expiresAt: expiresAt ?? undefined,
        });

        reply.send({ ok: true, granted: true, expiresAt });
        return;
      }

      // User doesn't exist yet — create migration claim
      await db.insert(migrationClaims).values({
        discordId: data.discordId,
        sellauthUsername: data.sellauthUsername ?? undefined,
        orderId: data.orderId,
        macro: data.macro,
        duration: data.duration,
        status: 'pending',
      });

      reply.send({ ok: true, granted: false, expiresAt });
      return;
    }

    // Only sellauthUsername — create migration claim
    if (data.sellauthUsername) {
      await db.insert(migrationClaims).values({
        sellauthUsername: data.sellauthUsername,
        orderId: data.orderId,
        macro: data.macro,
        duration: data.duration,
        status: 'pending',
      });

      reply.send({ ok: true, granted: false });
      return;
    }

    reply.code(400).send({ error: 'discordId or sellauthUsername is required' });
  });

  // ── POST /migration/import-row ───────────────────────────────────────────
  fastify.post('/migration/import-row', async (request, reply) => {
    await adminAuth(request, reply);
    if (reply.sent) return;

    const data = request.body as ImportRowBody;

    if (!data.orderId || !data.macro || !data.duration) {
      reply.code(400).send({ error: 'orderId, macro, and duration are required' });
      return;
    }

    // Dedup by orderId
    const existing = await db
      .select()
      .from(migrationClaims)
      .where(eq(migrationClaims.orderId, data.orderId))
      .limit(1)
      .then((rows: any[]) => rows[0] ?? null);

    if (existing) {
      reply.send({ ok: true, matched: false, granted: false, reason: 'Already imported' });
      return;
    }

    const purchasedAt = data.purchasedAt ? new Date(data.purchasedAt) : new Date();
    const { expiresAt, eligible } = calculateMigrationExpiry(data.duration, purchasedAt);

    if (!eligible) {
      reply.send({ ok: true, matched: false, granted: false, reason: 'Purchase too old' });
      return;
    }

    // Try to match sellauthUsername to existing user (exact case-insensitive).
    // Uses lower() = lower() instead of ilike to avoid wildcard injection
    // (ilike treats % and _ as wildcards, which could match unintended users
    // if a buyer typed % or _ in the SellAuth "Discord Name" custom field).
    if (data.sellauthUsername) {
      const trimmedLower = data.sellauthUsername.trim().toLowerCase();
      const user = await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = ${trimmedLower}`)
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);

      if (user) {
        // Grant (or extend) the macro — stacking extends the existing expiry.
        await upsertUserMacroExtend(db, user.discordId, data.macro, data.duration, expiresAt);

        reply.send({ ok: true, matched: true, granted: true });
        return;
      }
    }

    // Try discordId match
    if (data.discordId) {
      const user = await db
        .select()
        .from(users)
        .where(eq(users.discordId, data.discordId))
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);

      if (user) {
        await upsertUserMacroExtend(db, data.discordId, data.macro, data.duration, expiresAt);

        reply.send({ ok: true, matched: true, granted: true });
        return;
      }
    }

    // No match — create migration claim
    await db.insert(migrationClaims).values({
      discordId: data.discordId ?? undefined,
      sellauthUsername: data.sellauthUsername ?? undefined,
      orderId: data.orderId,
      macro: data.macro,
      duration: data.duration,
      status: 'pending',
    });

    reply.send({ ok: true, matched: false, granted: false });
  });
};

export default migrationPlugin;
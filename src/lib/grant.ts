import { eq, and, inArray } from 'drizzle-orm';
import { userMacros, licenseKeys } from '../db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Duration label → milliseconds; null = lifetime. Unknown labels count as 30 days. */
const DURATION_MS: Record<string, number | null> = {
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  '1m': 30 * DAY_MS,
  '30d': 30 * DAY_MS,
  lifetime: null,
};

export function durationMs(duration: string): number | null {
  return duration in DURATION_MS ? DURATION_MS[duration] : 30 * DAY_MS;
}

/** The stored sellauth_order_id of a bundle key (single-product keys store the order id as-is). */
export function bundleKeyOrderId(orderId: string, macro: string): string {
  return `${orderId}:${macro}`;
}

/**
 * Give a user one purchase of a macro, with the same rules as /licenses/redeem:
 * stack timed time onto an active expiry, start from now on an expired or
 * revoked row, upgrade timed → lifetime, and never downgrade an active
 * lifetime. licenseKeyId is the key whose refund takes this access away.
 * Run inside a transaction (the row is locked FOR UPDATE).
 */
export async function grantMacro(
  tx: any,
  g: { discordId: string; macro: string; duration: string; source: string; licenseKeyId: string | null },
): Promise<void> {
  const ms = durationMs(g.duration);
  const now = new Date();
  const [existing] = await tx
    .select()
    .from(userMacros)
    .where(and(eq(userMacros.discordId, g.discordId), eq(userMacros.macro, g.macro)))
    .limit(1)
    .for('update');

  if (!existing) {
    await tx.insert(userMacros).values({
      discordId: g.discordId,
      macro: g.macro,
      status: 'active',
      source: g.source,
      duration: ms === null ? 'lifetime' : g.duration,
      expiresAt: ms === null ? null : new Date(now.getTime() + ms),
      licenseKeyId: g.licenseKeyId,
    });
    return;
  }

  // An active lifetime already covers this purchase; leave it tied to the key that granted it.
  if (existing.status === 'active' && existing.expiresAt == null) return;

  let expiresAt: Date | null = null;
  if (ms !== null) {
    const current = existing.expiresAt ? new Date(existing.expiresAt) : null;
    const base = existing.status === 'active' && current && current > now ? current : now;
    expiresAt = new Date(base.getTime() + ms);
  }
  await tx
    .update(userMacros)
    .set({
      status: 'active',
      source: g.source,
      duration: ms === null ? 'lifetime' : g.duration,
      expiresAt,
      licenseKeyId: g.licenseKeyId,
      updatedAt: now,
    })
    .where(eq(userMacros.id, existing.id));
}

/**
 * Pay out a store purchase that was queued for sign-in (a pending entitlement
 * or migration claim). One purchase = one grant: if the order also delivered
 * a key, the payout uses that key up so it can't be redeemed again, and a key
 * that is already redeemed or turned off (refund) means there is nothing left
 * to pay. Orders with no key on record (legacy imports) pay out as before.
 *
 * `take` must atomically claim the queued row inside the transaction and
 * return false when another request already took it.
 */
export async function payOutQueuedPurchase(
  db: any,
  discordId: string,
  row: { orderId: string | null; macro: string; duration: string },
  take: (tx: any) => Promise<boolean>,
): Promise<void> {
  await db.transaction(async (tx: any) => {
    if (!(await take(tx))) return;

    let licenseKeyId: string | null = null;
    if (row.orderId) {
      const [key] = await tx
        .select({ id: licenseKeys.id, status: licenseKeys.status })
        .from(licenseKeys)
        .where(and(
          inArray(licenseKeys.sellauthOrderId, [row.orderId, bundleKeyOrderId(row.orderId, row.macro)]),
          eq(licenseKeys.macro, row.macro),
        ))
        .limit(1)
        .for('update');
      if (key) {
        if (key.status !== 'available') return;
        await tx
          .update(licenseKeys)
          .set({ status: 'redeemed', redeemedBy: discordId, redeemedAt: new Date() })
          .where(eq(licenseKeys.id, key.id));
        licenseKeyId = key.id;
      }
    }

    await grantMacro(tx, { discordId, macro: row.macro, duration: row.duration, source: 'migration', licenseKeyId });
  });
}

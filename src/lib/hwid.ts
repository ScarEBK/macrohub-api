import { eq } from 'drizzle-orm';
import { users, desktopSessions, trialRegistrations, adminLogs } from '../db/schema.js';

/**
 * Clear a user's HWID binding. Shared by POST /auth/clear-hwid and
 * POST /licenses/reset-hwid-by-key so both have identical effects.
 * Caller must have verified the user exists.
 */
export async function clearHwidForUser(db: any, discordId: string, details: Record<string, unknown> = {}) {
  // Null the stored HWID and allow a clean rebind on next sign-in.
  await db.update(users).set({
    hwid: null,
    hwidResetAllowed: true,
  }).where(eq(users.discordId, discordId));

  // M-11: invalidate existing desktop sessions so the old machine can't keep a stale token.
  await db.delete(desktopSessions).where(eq(desktopSessions.discordId, discordId));

  // H-4: clear trial registrations so a reset can't bypass the one-trial-per-machine lock.
  await db.delete(trialRegistrations).where(eq(trialRegistrations.discordId, discordId));

  // H-2: audit trail.
  await db.insert(adminLogs).values({
    action: 'clear_hwid',
    actorDiscordId: 'bot',
    targetDiscordId: discordId,
    details: JSON.stringify(details),
  });
}

const DISCORD_API = 'https://discord.com/api/v10';
const LOOKUP_TIMEOUT_MS = 4000;

/**
 * Resolve the current Discord username (handle) for a user id via the bot
 * token. Returns null when the token isn't configured or Discord can't be
 * reached — callers must treat null as "unverified" and fall back to
 * discordId-only matching.
 */
export async function fetchDiscordUsername(discordId: string): Promise<string | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !/^\d{5,25}$/.test(discordId)) return null;
  try {
    const res = await fetch(`${DISCORD_API}/users/${discordId}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { username?: unknown };
    return typeof body.username === 'string' && body.username.trim()
      ? body.username.trim()
      : null;
  } catch {
    return null;
  }
}

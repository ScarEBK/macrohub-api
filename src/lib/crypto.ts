import crypto from 'node:crypto';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const LICENSE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const REFERRAL_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function verifyOAuthProof(
  discordId: string,
  issuedAt: number,
  proof: string | null | undefined,
  secret: string,
): boolean {
  const now = Date.now();
  if (Math.abs(now - issuedAt) > FIVE_MINUTES_MS) {
    return false;
  }

  if (!proof || typeof proof !== 'string') {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${discordId}:${issuedAt}`)
    .digest('hex');

  return timingSafeEqual(proof, expected);
}

export function verifySellAuthSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  return timingSafeEqual(signature, expected);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateLicenseKey(): string {
  const segments: string[] = [];
  for (let s = 0; s < 6; s++) {
    let segment = '';
    for (let i = 0; i < 4; i++) {
      segment += LICENSE_CHARS[crypto.randomInt(LICENSE_CHARS.length)];
    }
    segments.push(segment);
  }
  return segments.join('-');
}

export function generateReferralCode(discordId: string): string {
  const last6 = discordId.slice(-6);
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += REFERRAL_CHARS[crypto.randomInt(REFERRAL_CHARS.length)];
  }
  return `MH${last6}${suffix}`;
}

export function normalizeLicenseKey(key: string): string[] {
  const stripped = key.replace(/[-\s]/g, '').toUpperCase();

  // Format 1: dashes every 4 chars (XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)
  const withDashes = stripped.match(/.{1,4}/g)?.join('-') ?? stripped;

  // Format 2: no dashes
  const noDashes = stripped;

  // Format 3: dashes with different grouping for 16-char keys (XXXXXX-XX-XXXXXX)
  let altGrouping = stripped;
  if (stripped.length === 16) {
    altGrouping = `${stripped.slice(0, 6)}-${stripped.slice(6, 8)}-${stripped.slice(8)}`;
  }

  return [withDashes, noDashes, altGrouping];
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
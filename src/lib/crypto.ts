import crypto from 'node:crypto';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

const LICENSE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const REFERRAL_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function verifyOAuthProof(
  discordId: string,
  issuedAt: number,
  proof: string | null | undefined,
  secret: string,
): boolean {
  const now = Date.now();
  if (Math.abs(now - issuedAt) > THIRTY_MINUTES_MS) {
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
  const bytes = crypto.randomBytes(16);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 24)}`;
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
  const stripped = key.trim().toUpperCase().replace(/[\s-]/g, '');

  // Current format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (24 hex chars)
  if (stripped.length === 24) {
    const withDashes =
      `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8, 12)}-` +
      `${stripped.slice(12, 16)}-${stripped.slice(16, 20)}-${stripped.slice(20, 24)}`;
    return [withDashes, stripped];
  }

  // Legacy Convex format: XXXX-XXXX-XXXX-XXXX (16 hex chars)
  if (stripped.length === 16) {
    const withDashes = `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12, 16)}`;
    return [withDashes, stripped];
  }

  return [stripped];
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from './lib/crypto.js';

// The public site reaches this API through a reverse proxy (Caddy) that puts
// the real client address in X-Forwarded-For. Believe that header only when
// the direct peer is on a loopback / private network (the proxy, other
// containers); a peer on the internet can't pick its own address this way.
export const TRUST_PROXY = 'loopback,linklocal,uniquelocal';

export const rateLimitOptions = {
  // Raised from 5000 to 20000/min when every client shared one bucket
  // behind the proxy. Per-client keys make this a generous per-IP ceiling.
  max: 20000,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => {
    // M-7 fix (audit 2026-06-19): previously any non-empty x-admin-secret
    // header (even a wrong one) yielded a private admin:<ip> bucket, giving
    // an attacker a dedicated 20k/min bucket separate from the shared IP
    // pool. Now only verified admin requests get the private bucket —
    // verify the secret with a timing-safe compare before keying. A wrong
    // secret falls through to the shared IP bucket (the adminAuth preHandler
    // will still 401 it downstream).
    const provided = request.headers['x-admin-secret'];
    const expected = process.env.ADMIN_SECRET;
    if (typeof provided === 'string' && typeof expected === 'string' && expected.length > 0) {
      // Cheap length gate then constant-time compare. Both sides are
      // app-controlled lengths so the length gate doesn't leak timing.
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        return `admin:${request.ip}`;
      }
    }
    return request.ip;
  },
};

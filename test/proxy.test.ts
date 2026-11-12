import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { TRUST_PROXY, rateLimitOptions } from '../src/server-config.js';

const PROXY = '172.18.0.3'; // reverse proxy / other container on the Docker network

describe('client address behind the reverse proxy', () => {
  let app: any;

  beforeEach(async () => {
    app = Fastify({ logger: false, trustProxy: TRUST_PROXY });
    await app.register(rateLimit, { ...rateLimitOptions, max: 2 });
    app.get('/ip', async (request: any) => ({ ip: request.ip }));
    await app.ready();
  });

  const get = (remoteAddress: string, forwardedFor?: string) =>
    app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });

  it('30. uses the forwarded client address when the peer is the proxy', async () => {
    const r = await get(PROXY, '203.0.113.10');
    expect(r.json().ip).toBe('203.0.113.10');
  });

  it('31. each client behind the proxy gets its own rate-limit bucket', async () => {
    expect((await get(PROXY, '203.0.113.10')).statusCode).toBe(200);
    expect((await get(PROXY, '203.0.113.10')).statusCode).toBe(200);
    expect((await get(PROXY, '203.0.113.10')).statusCode).toBe(429);
    expect((await get(PROXY, '198.51.100.20')).statusCode).toBe(200);
  });

  it('32. a peer on the internet cannot pick its address with the header', async () => {
    const r = await get('198.51.100.7', '203.0.113.99');
    expect(r.json().ip).toBe('198.51.100.7');
  });

  it('33. internal callers without the header keep their own address', async () => {
    const r = await get('172.18.0.9');
    expect(r.json().ip).toBe('172.18.0.9');
  });
});

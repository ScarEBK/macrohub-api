import { FastifyPluginCallback } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { verifySellAuthSignature, generateLicenseKey } from '../lib/crypto.js';
import {
  users,
  licenseKeys,
  userMacros,
  pendingEntitlements,
  migrationClaims,
} from '../db/schema.js';

// ── SKU mapping — REAL SellAuth product/variant IDs (verified from the
//    SellAuth API 2026-06-17). The old 762/763/764 IDs were stale and didn't
//    exist in the actual shop. Product names use bold Unicode math symbols
//    (𝐒𝐩𝐞𝐞𝐝 𝐁𝐨𝐨𝐬𝐭) so we map by stable variant IDs, not names. ────────────
const NUMERIC_SKU_LOOKUP: Record<string, { macro: string; duration: string }> = {
  // Speed Boost — product 112404
  '112404:158298': { macro: 'Speed Boost', duration: 'lifetime' },
  '112404:929411': { macro: 'Speed Boost', duration: '1m' },
  '112404:929412': { macro: 'Speed Boost', duration: '7d' },
  // Glitch Roll — product 89525
  '89525:146163': { macro: 'Glitch Roll', duration: 'lifetime' },
  '89525:929422': { macro: 'Glitch Roll', duration: '1m' },
  '89525:929423': { macro: 'Glitch Roll', duration: '7d' },
  // Strafe — product 100843
  '100843:151984': { macro: 'Strafe', duration: 'lifetime' },
  '100843:929403': { macro: 'Strafe', duration: '1m' },
  '100843:929404': { macro: 'Strafe', duration: '7d' },
};

// Legacy IDs kept for backward compat with any old SellAuth webhook configs.
const LEGACY_SKU_LOOKUP: Record<string, { macro: string; duration: string }> = {
  '762:1368': { macro: 'Speed Boost', duration: '1m' },
  '762:1369': { macro: 'Speed Boost', duration: 'lifetime' },
  '762:1370': { macro: 'Speed Boost', duration: '7d' },
  '763:1371': { macro: 'Glitch Roll', duration: '1m' },
  '763:1372': { macro: 'Glitch Roll', duration: 'lifetime' },
  '763:1373': { macro: 'Glitch Roll', duration: '7d' },
  '764:1374': { macro: 'Strafe', duration: '1m' },
  '764:1375': { macro: 'Strafe', duration: 'lifetime' },
  '764:1376': { macro: 'Strafe', duration: '7d' },
};

const MACRO_KEYWORDS = ['Speed Boost', 'Glitch Roll', 'Strafe'] as const;
const DURATION_KEYWORDS: Record<string, string> = {
  '1m': '1m',
  '1 month': '1m',
  '7d': '7d',
  '7 day': '7d',
  '7 days': '7d',
  lifetime: 'lifetime',
  life: 'lifetime',
  '30 day': '1m',
  '30 days': '1m',
};

const BUNDLE_MACROS = ['Speed Boost', 'Glitch Roll', 'Strafe'] as const;

interface SellAuthWebhookBody {
  event?: string;
  order_id?: string;
  product_id?: number | string;
  variant_id?: number | string;
  custom_fields?: {
    discord_id?: string;
    discord_username?: string;
    [key: string]: unknown;
  };
  customer?: {
    discord_id?: string;
    username?: string;
    [key: string]: unknown;
  };
  discord_id?: string;
  product?: {
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function resolveSkuMapping(
  productId: number | string | undefined,
  variantId: number | string | undefined,
  productName: string | undefined,
  envSkuMap: Record<string, string> | undefined,
): { macro: string; duration: string; isBundle: boolean } | null {
  // 1. Hardcoded numeric lookup (real + legacy IDs)
  if (productId != null && variantId != null) {
    const key = `${productId}:${variantId}`;
    const match = NUMERIC_SKU_LOOKUP[key] ?? LEGACY_SKU_LOOKUP[key];
    if (match) {
      return { ...match, isBundle: false };
    }
  }

  // 2. Env var SKU map
  if (envSkuMap && productId != null && variantId != null) {
    const key = `${productId}:${variantId}`;
    const mapped = envSkuMap[key];
    if (mapped) {
      const [macro, duration] = mapped.split('|');
      if (macro && duration) {
        const isBundle = macro.toLowerCase() === 'all' || macro.toLowerCase() === 'bundle';
        return { macro, duration, isBundle };
      }
    }
  }

  // 3. Fallback: parse product name
  if (productName) {
    const lower = productName.toLowerCase();
    let macro: string | null = null;
    let duration = 'lifetime';

    for (const kw of MACRO_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) {
        macro = kw;
        break;
      }
    }

    if (lower.includes('all') || lower.includes('bundle') || lower.includes('full')) {
      return { macro: 'all', duration: 'lifetime', isBundle: true };
    }

    for (const [pattern, dur] of Object.entries(DURATION_KEYWORDS)) {
      if (lower.includes(pattern)) {
        duration = dur;
        break;
      }
    }

    if (macro) {
      return { macro, duration, isBundle: false };
    }
  }

  return null;
}

function calculateExpiry(duration: string): Date | null {
  const now = new Date();
  switch (duration) {
    case '1m':
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    case 'lifetime':
      return null;
    default:
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  }
}

const sellauthPlugin: FastifyPluginCallback = async (fastify) => {
  const db = fastify.db;

  // ── POST /sellauth/webhook ──────────────────────────────────────────────
  fastify.post('/sellauth/webhook', async (request, reply) => {
    // Use the raw body captured by the content-type parser (registered in
    // index.ts). This ensures the HMAC signature is verified over the exact
    // bytes SellAuth signed, not a re-serialized JSON string.
    const rawBody = (request as any).rawBody ?? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
    const signature = request.headers['x-signature'] as string | undefined;
    const webhookSecret = process.env.SELLAUTH_WEBHOOK_SECRET;

    if (!webhookSecret) {
      request.log.error('SELLAUTH_WEBHOOK_SECRET env var is not set');
      reply.code(500).send({ error: 'Server misconfiguration' });
      return;
    }

    if (!signature || !verifySellAuthSignature(rawBody, signature, webhookSecret)) {
      reply.code(401).send({ error: 'Invalid signature' });
      return;
    }

    let body: SellAuthWebhookBody;
    try {
      body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body as SellAuthWebhookBody);
    } catch {
      reply.code(400).send({ error: 'Invalid JSON' });
      return;
    }

    // Acknowledge notification events (no fulfillment needed)
    if (body.event?.startsWith('NOTIFICATION')) {
      reply.code(200).send({ ok: true });
      return;
    }

    const orderId = String(body.order_id ?? '');
    const productId = body.product_id;
    const variantId = body.variant_id;
    const productName = typeof body.product?.name === 'string' ? body.product.name : undefined;

    // Extract discordId from multiple possible locations
    const discordId =
      body.custom_fields?.discord_id ||
      body.customer?.discord_id ||
      body.discord_id ||
      null;

    // Extract sellauthUsername (non-numeric only)
    let sellauthUsername: string | null = null;
    const customUsername = body.custom_fields?.discord_username;
    const customerUsername = body.customer?.username;

    if (customUsername && typeof customUsername === 'string' && !/^\d+$/.test(customUsername)) {
      sellauthUsername = customUsername;
    } else if (customerUsername && typeof customerUsername === 'string' && !/^\d+$/.test(customerUsername)) {
      sellauthUsername = customerUsername;
    }

    // Parse env SKU map
    let envSkuMap: Record<string, string> | undefined;
    const envSkuMapStr = process.env.SELLAUTH_SKU_MAP;
    if (envSkuMapStr) {
      try {
        envSkuMap = JSON.parse(envSkuMapStr);
      } catch {
        request.log.warn('Failed to parse SELLAUTH_SKU_MAP env var');
      }
    }

    const skuResult = resolveSkuMapping(productId, variantId, productName, envSkuMap);

    if (!skuResult) {
      request.log.error({ orderId, productId, variantId, productName }, 'Could not resolve SKU mapping');
      reply.code(400).send({ error: 'Unknown product/variant combination' });
      return;
    }

    const { isBundle } = skuResult;

    // ── Fulfillment runs inside a transaction. The unique index on
    //    license_keys.sellauth_order_id makes concurrent SellAuth webhook
    //    retries safe: the second delivery's INSERT fails with a unique
    //    violation, we catch it, re-read the existing keys, and return them
    //    idempotently — no duplicate keys, no duplicate grants. ────────────
    const fulfilledKeys = await db.transaction(async (tx) => {
      // Idempotency: if keys already exist for this order, return them.
      if (orderId) {
        const existing = await tx
          .select()
          .from(licenseKeys)
          .where(eq(licenseKeys.sellauthOrderId, orderId));
        if (existing.length > 0) {
          return existing.map((k: any) => k.key);
        }
      }

      try {
        // ── Bundle order (all 3 macros) ─────────────────────────────────────
        if (isBundle) {
          const keys: string[] = [];

          for (const macro of BUNDLE_MACROS) {
            const duration = skuResult.duration;
            const key = generateLicenseKey();

            await tx.insert(licenseKeys).values({
              key,
              status: 'available',
              macro,
              duration,
              sellauthOrderId: orderId,
            });

            keys.push(key);
          }

          // If discordId found and user exists, grant all 3 macros and redeem keys
          if (discordId) {
            const user = await tx
              .select()
              .from(users)
              .where(eq(users.discordId, discordId))
              .limit(1)
              .then((rows: any[]) => rows[0] ?? null);

            if (user) {
              const createdKeys = await tx
                .select()
                .from(licenseKeys)
                .where(eq(licenseKeys.sellauthOrderId, orderId));

              for (const lk of createdKeys) {
                const expiresAt = calculateExpiry(lk.duration);

                await tx.insert(userMacros).values({
                  discordId,
                  macro: lk.macro,
                  status: 'active',
                  source: 'sellauth',
                  duration: lk.duration,
                  expiresAt: expiresAt ?? undefined,
                  licenseKeyId: lk.id,
                }).onConflictDoNothing();

                await tx
                  .update(licenseKeys)
                  .set({ status: 'redeemed', redeemedBy: discordId, redeemedAt: new Date() })
                  .where(eq(licenseKeys.id, lk.id));
              }
            } else {
              // User not found yet — create pending entitlements (orderId
              // is stored so the idempotency check above de-dupes retries).
              for (const macro of BUNDLE_MACROS) {
                await tx.insert(pendingEntitlements).values({
                  discordId: discordId,
                  macro,
                  duration: skuResult.duration,
                  source: 'sellauth',
                  orderId,
                });
              }
            }
          } else {
            // No discordId — create migration claims by sellauthUsername.
            // Leave sellauthUsername NULL (not 'unknown') so it can't
            // accidentally match a Discord user literally named "unknown".
            for (const macro of BUNDLE_MACROS) {
              await tx.insert(migrationClaims).values({
                sellauthUsername: sellauthUsername ?? null,
                orderId,
                macro,
                duration: skuResult.duration,
                status: 'pending',
              });
            }
          }

          const createdKeys = await tx
            .select()
            .from(licenseKeys)
            .where(eq(licenseKeys.sellauthOrderId, orderId));

          return createdKeys.map((k: any) => k.key);
        }

        // ── Single product order ───────────────────────────────────────────
        const { macro, duration } = skuResult;
        const key = generateLicenseKey();
        const expiresAt = calculateExpiry(duration);

        await tx.insert(licenseKeys).values({
          key,
          status: 'available',
          macro,
          duration,
          sellauthOrderId: orderId,
        });

        if (discordId) {
          const user = await tx
            .select()
            .from(users)
            .where(eq(users.discordId, discordId))
            .limit(1)
            .then((rows: any[]) => rows[0] ?? null);

          if (user) {
            const createdKey = await tx
              .select()
              .from(licenseKeys)
              .where(eq(licenseKeys.key, key))
              .limit(1)
              .then((rows: any[]) => rows[0]);

            await tx.insert(userMacros).values({
              discordId,
              macro,
              status: 'active',
              source: 'sellauth',
              duration,
              expiresAt: expiresAt ?? undefined,
              licenseKeyId: createdKey!.id,
            }).onConflictDoNothing();

            await tx
              .update(licenseKeys)
              .set({ status: 'redeemed', redeemedBy: discordId, redeemedAt: new Date() })
              .where(eq(licenseKeys.key, key));
          } else {
            // User not found — create migration claim (resolves on sign-in)
            await tx.insert(migrationClaims).values({
              discordId,
              sellauthUsername: sellauthUsername ?? undefined,
              orderId,
              macro,
              duration,
              status: 'pending',
            });
          }
        } else if (sellauthUsername) {
          // No discordId but has sellauthUsername — create migration claim
          await tx.insert(migrationClaims).values({
            sellauthUsername,
            orderId,
            macro,
            duration,
            status: 'pending',
          });
        } else {
          // No discordId at all — create pending entitlement. Use a non-numeric
          // sentinel (Discord IDs are all-numeric snowflakes) so it can never
          // bind to a real user, unlike the previous 'unknown' literal which
          // could have matched a user literally named "unknown".
          await tx.insert(pendingEntitlements).values({
            discordId: '__no_discord__',
            macro,
            duration,
            source: 'sellauth',
            orderId,
          });
        }

        return [key];
      } catch (err: any) {
        // Unique violation on sellauth_order_id = a concurrent retry already
        // inserted keys for this order. Re-read them and return idempotently.
        if (orderId && /unique|duplicate|23505/i.test(err?.message ?? String(err))) {
          const existing = await tx
            .select()
            .from(licenseKeys)
            .where(eq(licenseKeys.sellauthOrderId, orderId));
          if (existing.length > 0) {
            return existing.map((k: any) => k.key);
          }
        }
        throw err;
      }
    });

    reply.code(200).send(fulfilledKeys.join('\n'));
  });
};

export default sellauthPlugin;
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

// ── SKU mapping (mirrors Convex NUMERIC_SKU_LOOKUP) ──────────────────────────
const NUMERIC_SKU_LOOKUP: Record<string, { macro: string; duration: string }> = {
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
  // 1. Hardcoded numeric lookup
  if (productId != null && variantId != null) {
    const key = `${productId}:${variantId}`;
    const match = NUMERIC_SKU_LOOKUP[key];
    if (match) {
      const isBundle = Object.values(NUMERIC_SKU_LOOKUP).filter(
        (v) => v.macro === match.macro && v.duration === match.duration,
      ).length > 0 && match.macro === 'Speed Boost' && match.duration === 'lifetime'
        ? false
        : false;
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
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
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

    // Acknowledge notification events
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

    // ── Bundle order (all 3 macros) ───────────────────────────────────────
    if (isBundle) {
      const keys: string[] = [];

      for (const macro of BUNDLE_MACROS) {
        const duration = skuResult.duration;
        const key = generateLicenseKey();
        const expiresAt = calculateExpiry(duration);

        await db.insert(licenseKeys).values({
          key,
          status: 'available',
          macro,
          duration,
          discordId: discordId ?? undefined,
          sellauthOrderId: orderId,
        });

        keys.push(key);
      }

      // If discordId found and user exists, grant all 3 macros and redeem keys
      if (discordId) {
        const user = await db
          .select()
          .from(users)
          .where(eq(users.discordId, discordId))
          .limit(1)
          .then((rows: any[]) => rows[0] ?? null);

        if (user) {
          const createdKeys = await db
            .select()
            .from(licenseKeys)
            .where(eq(licenseKeys.sellauthOrderId, orderId));

          for (const lk of createdKeys) {
            const expiresAt = calculateExpiry(lk.duration);

            await db.insert(userMacros).values({
              discordId,
              macro: lk.macro,
              status: 'active',
              source: 'sellauth',
              duration: lk.duration,
              expiresAt: expiresAt ?? undefined,
              licenseKeyId: lk.id,
            });

            await db
              .update(licenseKeys)
              .set({ status: 'redeemed', redeemedBy: discordId, redeemedAt: new Date() })
              .where(eq(licenseKeys.id, lk.id));
          }
        } else {
          // User not found yet — create pending entitlements
          for (const macro of BUNDLE_MACROS) {
            await db.insert(pendingEntitlements).values({
              discordId: discordId!,
              macro,
              duration: skuResult.duration,
              source: 'sellauth',
              orderId,
            });
          }
        }
      } else {
        // No discordId at all — create pending entitlements with placeholder
        for (const macro of BUNDLE_MACROS) {
          await db.insert(pendingEntitlements).values({
            discordId: sellauthUsername ?? 'unknown',
            macro,
            duration: skuResult.duration,
            source: 'sellauth',
            orderId,
          });
        }
      }

      const createdKeys = await db
        .select()
        .from(licenseKeys)
        .where(eq(licenseKeys.sellauthOrderId, orderId));

      reply.code(200).send(createdKeys.map((k: any) => k.key).join('\n'));
      return;
    }

    // ── Single product order ──────────────────────────────────────────────
    const { macro, duration } = skuResult;
    const key = generateLicenseKey();
    const expiresAt = calculateExpiry(duration);

    await db.insert(licenseKeys).values({
      key,
      status: 'available',
      macro,
      duration,
      discordId: discordId ?? undefined,
      sellauthOrderId: orderId,
    });

    if (discordId) {
      const user = await db
        .select()
        .from(users)
        .where(eq(users.discordId, discordId))
        .limit(1)
        .then((rows: any[]) => rows[0] ?? null);

      if (user) {
        // Redeem key and grant userMacro
        const createdKey = await db
          .select()
          .from(licenseKeys)
          .where(eq(licenseKeys.key, key))
          .limit(1)
          .then((rows: any[]) => rows[0]);

        await db.insert(userMacros).values({
          discordId,
          macro,
          status: 'active',
          source: 'sellauth',
          duration,
          expiresAt: expiresAt ?? undefined,
          licenseKeyId: createdKey!.id,
        });

        await db
          .update(licenseKeys)
          .set({ status: 'redeemed', redeemedBy: discordId, redeemedAt: new Date() })
          .where(eq(licenseKeys.key, key));
      } else {
        // User not found — create migration claim
        await db.insert(migrationClaims).values({
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
      await db.insert(migrationClaims).values({
        sellauthUsername,
        orderId,
        macro,
        duration,
        status: 'pending',
      });
    } else {
      // No discordId at all — create pending entitlement
      await db.insert(pendingEntitlements).values({
        discordId: 'unknown',
        macro,
        duration,
        source: 'sellauth',
        orderId,
      });
    }

    reply.code(200).send(key);
  });
};

export default sellauthPlugin;
// Rate limiting for the hub. The shared, cross-restart limiter is the same
// mechanism auth-web uses — the `rate_limit_buckets` table (one atomic upsert
// per check) — re-implemented here only because
// apps/auth-web/src/lib/rate-limit.ts imports next/server and therefore cannot
// be consumed from this service. The table, the key convention
// ("<action>:<identity>") and the fixed-window semantics are deliberately
// identical, so limits hold across both services.
import type { IncomingMessage } from "node:http";
import { sql } from "drizzle-orm";
import { createDb, rateLimitBuckets } from "@frameos-cloud/db";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  resetAt: number;
}

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let operationsSinceSweep = 0;
const sweepEvery = 1000;

function bumpSweepCounter(now: number) {
  // Evict expired buckets periodically so rotating keys (spoofed IPs, churning
  // frame ids) cannot grow the map without bound.
  operationsSinceSweep += 1;
  if (operationsSinceSweep < sweepEvery) {
    return false;
  }
  operationsSinceSweep = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
  return true;
}

// Per-instance fixed window. Used directly for per-frame limits, where the
// single-host constraint (cloud/docs/cloud-frames.md) already makes this
// process the only writer for a given frame, and a database round trip per
// message would cost more than the work being limited.
export function checkMemoryRateLimit(
  key: string,
  options: RateLimitOptions,
  now = Date.now(),
): RateLimitResult {
  bumpSweepCounter(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + options.windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: options.limit >= 1, resetAt };
  }
  if (existing.count >= options.limit) {
    return { allowed: false, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return { allowed: true, resetAt: existing.resetAt };
}

// Shared fixed window backed by Postgres, so an unauthenticated flood cannot
// be reset by restarting the hub or by spreading across replicas. Falls back
// to the in-memory buckets when the database errors: a database blip must
// neither disable the limit nor turn every upgrade into a 429.
export async function checkSharedRateLimit(
  db: ReturnType<typeof createDb>,
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const sweep = bumpSweepCounter(Date.now());
  const windowInterval = sql`make_interval(secs => ${options.windowMs / 1000})`;
  try {
    const rows = await db
      .insert(rateLimitBuckets)
      .values({ count: 1, key, resetAt: sql`now() + ${windowInterval}` })
      .onConflictDoUpdate({
        set: {
          count: sql`CASE WHEN ${rateLimitBuckets.resetAt} <= now() THEN 1 ELSE ${rateLimitBuckets.count} + 1 END`,
          resetAt: sql`CASE WHEN ${rateLimitBuckets.resetAt} <= now() THEN now() + ${windowInterval} ELSE ${rateLimitBuckets.resetAt} END`,
        },
        target: rateLimitBuckets.key,
      })
      .returning({
        count: rateLimitBuckets.count,
        resetAt: rateLimitBuckets.resetAt,
      });
    if (sweep) {
      await db
        .delete(rateLimitBuckets)
        .where(sql`${rateLimitBuckets.resetAt} <= now()`);
    }
    const row = rows[0];
    if (!row) {
      throw new Error("rate limit upsert returned no row");
    }
    return {
      allowed: row.count <= options.limit,
      resetAt: row.resetAt.getTime(),
    };
  } catch {
    return checkMemoryRateLimit(key, options);
  }
}

// Number of trusted reverse proxies in front of the hub, read from the same
// variable auth-web uses (see its rate-limit.ts): the client IP is the entry
// appended by the closest trusted proxy, i.e. the Nth-from-the-right of the
// X-Forwarded-For chain. Entries further left are client-controlled.
function trustedProxyCount() {
  const raw = process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

export function clientIpFromRequest(req: IncomingMessage) {
  const count = trustedProxyCount();
  if (count > 0) {
    const header = req.headers["x-forwarded-for"];
    const chain = (Array.isArray(header) ? header.join(",") : (header ?? ""))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      const clientIp = chain[Math.max(0, chain.length - count)];
      if (clientIp) {
        return clientIp;
      }
    }
  }
  const realIp = req.headers["x-real-ip"];
  const single = Array.isArray(realIp) ? realIp[0] : realIp;
  return single?.trim() || req.socket.remoteAddress || "local";
}

export function resetRateLimitsForTests() {
  buckets.clear();
  operationsSinceSweep = 0;
}

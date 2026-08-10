import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createDb, rateLimitBuckets } from "@frameos-cloud/db";
import { hasDatabaseUrl } from "./env";

type Bucket = {
  count: number;
  resetAt: number;
};

// Fixed-window limits backed by Postgres, so they hold across app replicas
// and survive restarts. The in-memory buckets remain as the store for
// database-less contexts (unit tests, misconfigured dev) and as the fallback
// when the database query fails — a database outage must not turn every
// endpoint into a 429 or disable limits entirely.
const buckets = new Map<string, Bucket>();

let operationsSinceSweep = 0;
const sweepEvery = 1000;

function sweepExpired(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function bumpSweepCounter(now: number) {
  // Evict expired buckets periodically so spoofed/rotating keys cannot grow
  // the map (or table) without bound.
  operationsSinceSweep += 1;
  if (operationsSinceSweep >= sweepEvery) {
    operationsSinceSweep = 0;
    sweepExpired(now);
    return true;
  }
  return false;
}

function checkRateLimitInMemory(
  key: string,
  options: {
    limit: number;
    now: number;
    windowMs: number;
  },
) {
  const now = options.now;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, remaining: options.limit - 1, resetAt: now + options.windowMs };
  }

  if (existing.count >= options.limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: options.limit - existing.count,
    resetAt: existing.resetAt,
  };
}

async function checkRateLimitInDatabase(
  key: string,
  options: {
    limit: number;
    windowMs: number;
  },
  sweep: boolean,
) {
  const db = createDb();
  // One atomic upsert decides the outcome: expired windows restart at 1,
  // live windows increment. Counting past the limit is harmless — only the
  // comparison against `limit` matters, and reset_at never moves inside a
  // window, so denied attempts cannot extend it.
  const windowInterval = sql`make_interval(secs => ${options.windowMs / 1000})`;
  const rows = await db
    .insert(rateLimitBuckets)
    .values({
      count: 1,
      key,
      resetAt: sql`now() + ${windowInterval}`,
    })
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
  const allowed = row.count <= options.limit;
  return {
    allowed,
    remaining: allowed ? options.limit - row.count : 0,
    resetAt: row.resetAt.getTime(),
  };
}

export async function checkRateLimit(
  key: string,
  options: {
    limit: number;
    now?: number;
    windowMs: number;
  },
) {
  const now = options.now ?? Date.now();
  const sweep = bumpSweepCounter(now);

  // A caller-supplied clock only makes sense for the in-memory store; the
  // database path uses the database's own now().
  if (options.now === undefined && hasDatabaseUrl()) {
    try {
      return await checkRateLimitInDatabase(key, options, sweep);
    } catch {
      // Fall through to the per-instance buckets.
    }
  }

  return checkRateLimitInMemory(key, { ...options, now });
}

function tooManyRequests(resetAt: number) {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
  return NextResponse.json(
    { error: "rate_limited", retry_after: retryAfter },
    {
      headers: { "retry-after": String(retryAfter) },
      status: 429,
    },
  );
}

export async function rateLimitResponse(
  request: NextRequest,
  action: string,
  options: {
    limit: number;
    windowMs: number;
  },
) {
  const result = await checkRateLimit(`${action}:${clientKey(request)}`, options);
  if (result.allowed) {
    return undefined;
  }

  return tooManyRequests(result.resetAt);
}

// Rate limit keyed on a non-spoofable identity (e.g. the authenticated account)
// rather than the client IP. Used to cap brute-force guessing of device user
// codes by a logged-in attacker, which the IP-based limit cannot reliably stop.
export async function identityRateLimitResponse(
  identity: string,
  action: string,
  options: {
    limit: number;
    windowMs: number;
  },
) {
  const result = await checkRateLimit(`${action}:identity:${identity}`, options);
  if (result.allowed) {
    return undefined;
  }

  return tooManyRequests(result.resetAt);
}

export function resetRateLimitForTests() {
  buckets.clear();
  operationsSinceSweep = 0;
}

// Number of trusted reverse proxies in front of the app. The client IP is the
// entry appended by the closest trusted proxy, i.e. the Nth-from-the-right of
// the X-Forwarded-For chain. Entries further left are client-controlled and
// must not be trusted. Defaults to 1 (a single reverse proxy); set to 0 only
// when the app is exposed directly with no proxy.
function trustedProxyCount() {
  const raw = process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
  if (raw === undefined) {
    return 1;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

export function clientKey(request: NextRequest) {
  return clientIpFromHeaders(request.headers);
}

// The client IP the trusted-proxy config says to believe; also used to stamp
// audit events (see lib/audit.ts).
export function clientIpFromHeaders(headers: Headers) {
  const count = trustedProxyCount();
  if (count > 0) {
    const chain = headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (chain && chain.length > 0) {
      const index = Math.max(0, chain.length - count);
      const clientIp = chain[index];
      if (clientIp) {
        return clientIp;
      }
    }
  }

  return headers.get("x-real-ip")?.trim() || "local";
}

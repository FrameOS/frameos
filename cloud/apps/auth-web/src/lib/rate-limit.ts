import { NextRequest, NextResponse } from "next/server";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

// In-memory buckets are per-instance only; a multi-replica deployment needs a
// shared store (e.g. Redis) for limits to hold across instances.
let operationsSinceSweep = 0;
const sweepEvery = 1000;

function sweepExpired(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(
  key: string,
  options: {
    limit: number;
    now?: number;
    windowMs: number;
  },
) {
  const now = options.now ?? Date.now();

  // Evict expired buckets periodically so spoofed/rotating keys cannot grow the
  // map without bound.
  operationsSinceSweep += 1;
  if (operationsSinceSweep >= sweepEvery) {
    operationsSinceSweep = 0;
    sweepExpired(now);
  }

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

export function rateLimitResponse(
  request: NextRequest,
  action: string,
  options: {
    limit: number;
    windowMs: number;
  },
) {
  const result = checkRateLimit(`${action}:${clientKey(request)}`, options);
  if (result.allowed) {
    return undefined;
  }

  return tooManyRequests(result.resetAt);
}

// Rate limit keyed on a non-spoofable identity (e.g. the authenticated account)
// rather than the client IP. Used to cap brute-force guessing of device user
// codes by a logged-in attacker, which the IP-based limit cannot reliably stop.
export function identityRateLimitResponse(
  identity: string,
  action: string,
  options: {
    limit: number;
    windowMs: number;
  },
) {
  const result = checkRateLimit(`${action}:identity:${identity}`, options);
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

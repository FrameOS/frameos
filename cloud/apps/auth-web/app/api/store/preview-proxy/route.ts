import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../src/lib/store-cache";

export const runtime = "nodejs";

const maxResponseBytes = 10 * 1024 * 1024;
const maxBodyBytes = 1024 * 1024;
const maxTimeoutMs = 30_000;

// Server-side HTTP fetch for the in-browser scene live preview, mirroring the
// frameos backend's scene_preview_proxy. The wasm runtime fetches URLs
// directly from the browser first and only falls back here when CORS blocks
// the host, so this stays a low-traffic escape hatch. Anonymous (previews
// are public), so it is tightly capped and SSRF-guarded.
// Body: {method, url, headers, bodyBase64, timeoutMs}; the response mirrors
// the upstream status and bytes.
async function handlePost(request: NextRequest) {
  const limited = await rateLimitResponse(request, "store:preview-proxy", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = await readJsonObject(request);
  const method = String(body.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "HEAD"].includes(method)) {
    return jsonError("method_not_allowed", 400);
  }

  let url: URL;
  try {
    url = new URL(String(body.url ?? ""));
  } catch {
    return jsonError("invalid_url", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return jsonError("invalid_url", 400);
  }
  if (await hostIsBlocked(url.hostname)) {
    return jsonError("host_not_allowed", 403);
  }

  const requestBody =
    typeof body.bodyBase64 === "string" && body.bodyBase64
      ? Buffer.from(body.bodyBase64, "base64")
      : undefined;
  if (requestBody && requestBody.length > maxBodyBytes) {
    return jsonError("body_too_large", 413);
  }

  // Forward app-supplied headers minus hop-by-hop / host-scoped ones; our own
  // cookies never leave (the browser sends them to us, not through us).
  const headers = new Headers();
  if (body.headers && typeof body.headers === "object") {
    for (const [key, value] of Object.entries(
      body.headers as Record<string, unknown>,
    )) {
      if (
        typeof value === "string" &&
        !["host", "content-length", "connection", "cookie"].includes(
          key.toLowerCase(),
        )
      ) {
        headers.set(key, value);
      }
    }
  }

  const requestedTimeout = Number(body.timeoutMs ?? 0);
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, maxTimeoutMs)
      : maxTimeoutMs;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      body: (requestBody ?? null) as BodyInit | null,
      headers,
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return jsonError("proxy_fetch_failed", 502, {
      detail: error instanceof Error ? error.message || error.name : String(error),
    });
  }

  const bytes = await readCapped(upstream, maxResponseBytes);
  if (bytes === null) {
    return jsonError("response_too_large", 502);
  }

  return new NextResponse(bytes as BodyInit, {
    headers: {
      "cache-control": "no-store",
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
    },
    status: upstream.status,
  });
}

// SSRF guard, mirroring frameos' _preview_proxy_host_is_blocked: reject hosts
// resolving to loopback / private / link-local / reserved addresses so the
// proxy cannot probe our internal network. DNS resolves once here; a rebind
// between check and fetch is a residual risk accepted for a preview feature.
async function hostIsBlocked(hostname: string): Promise<boolean> {
  const literal = isIP(hostname) ? [hostname] : null;
  let addresses: string[];
  if (literal) {
    addresses = literal;
  } else {
    try {
      const results = await lookup(hostname, { all: true, verbatim: true });
      addresses = results.map((result) => result.address);
    } catch {
      return true;
    }
  }
  return addresses.length === 0 || addresses.some(addressIsPrivate);
}

function addressIsPrivate(address: string): boolean {
  const plain = address.split("%")[0] ?? address;
  if (isIP(plain) === 4) {
    const octets = plain.split(".").map(Number);
    const [a = -1, b = -1] = octets;
    return (
      a === 0 || // unspecified
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + reserved
    );
  }
  const lower = plain.toLowerCase();
  // Loopback, unspecified, link-local, unique-local, and v4-mapped forms.
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:")
  );
}

async function readCapped(
  response: Response,
  cap: number,
): Promise<Buffer | null> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const POST = storeRoute(handlePost);

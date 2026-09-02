import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import { jsonError, readJsonObject } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { guardedFetch } from "../../../../src/lib/ssrf";
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
  // Only the preview worker (a same-origin XHR sending JSON) may call this.
  // Without these two checks a cross-site form POST could reach it, and the
  // response — bytes we did not author — would render on our origin.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonError("invalid_content_type", 415);
  }
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
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
        ![
          "authorization",
          "connection",
          "content-length",
          "cookie",
          "host",
          "proxy-authorization",
        ].includes(key.toLowerCase())
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

  // guardedFetch re-checks the host on every redirect hop, so a public URL
  // cannot bounce to a loopback or metadata address.
  let upstream: Response;
  try {
    upstream = await guardedFetch(url.toString(), {
      body: (requestBody ?? null) as BodyInit | null,
      headers,
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "host_not_allowed") {
      return jsonError("host_not_allowed", 403);
    }
    return jsonError("proxy_fetch_failed", 502, {
      detail: message || (error instanceof Error ? error.name : "error"),
    });
  }

  const bytes = await readCapped(upstream, maxResponseBytes);
  if (bytes === null) {
    return jsonError("response_too_large", 502);
  }

  // Never mirror the upstream type: the worker only wants the bytes, and a
  // text/html answer must not be something a browser would render on this
  // origin. The upstream type travels in a side header for callers that care.
  return new NextResponse(bytes as BodyInit, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": "attachment",
      "content-security-policy": "sandbox",
      "content-type": "application/octet-stream",
      "x-upstream-content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
    },
    status: upstream.status,
  });
}

// The SSRF guard itself lives in src/lib/ssrf.ts, shared with the MCP
// server's scene imports.

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

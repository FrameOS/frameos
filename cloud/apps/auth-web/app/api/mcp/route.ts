import { createFrameosMcpServer, serveStatelessHttp } from "@frameos-cloud/mcp";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  bearerToken,
  isApiToken,
} from "../../../src/lib/api-tokens";
import { jsonError, requireDatabase } from "../../../src/lib/device-flow";
import { getCloudBaseUrl, getScenesBaseUrl } from "../../../src/lib/env";
import { logWarn } from "../../../src/lib/log";
import { rateLimitResponse } from "../../../src/lib/rate-limit";
import { guardedFetch } from "../../../src/lib/ssrf";

export const runtime = "nodejs";
export const maxDuration = 120;

// The hosted MCP server: Model Context Protocol over Streamable HTTP, at
// POST /api/mcp, authenticated with a personal API token in the
// Authorization header. Stateless — every request builds a fresh server and
// transport, and every tool call is an HTTP request back to this same app's
// JSON routes with the caller's token (packages/mcp is a thin wrapper, on
// purpose: the routes stay the one place behaviour and limits live). The
// loopback origin is the process's own request origin, so the calls never
// leave the box and never cross Cloudflare; the client's forwarded-for
// chain rides along so the routes' per-IP rate limits key on the real
// caller, not on 127.0.0.1.
//
// GET (the optional server-initiated SSE stream) and DELETE (session end)
// are meaningless without sessions and are answered 405 so clients fall
// back to plain request/response.

const forwardedHeaders = [
  "cf-connecting-ip",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

// Where this process answers HTTP, for the tool calls' self-fetch. NOT
// `new URL(request.url).origin`: behind nginx Next reports that as
// `https://localhost:3000` (see getPublicOrigin in src/lib/env.ts), and a TLS
// handshake against the plain-HTTP Node port fails every tool call with
// "fetch failed". The systemd unit starts the server with PORT=<instance> and
// HOSTNAME=127.0.0.1, so plain http on the loopback address and that port is
// the address that actually works; FRAMEOS_MCP_INTERNAL_ORIGIN overrides it.
function internalOrigin(): string {
  const configured = process.env.FRAMEOS_MCP_INTERNAL_ORIGIN?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const port = process.env.PORT?.trim() || "3000";
  return `http://127.0.0.1:${port}`;
}

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "mcp:request", {
    limit: 1200,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const token = bearerToken(request.headers.get("authorization"));
  if (!isApiToken(token)) {
    return NextResponse.json(
      {
        error: "login_required",
        hint: "Send `Authorization: Bearer fc_api_…` with a personal API token from /account/developer.",
      },
      {
        headers: { "www-authenticate": 'Bearer realm="FrameOS Cloud"' },
        status: 401,
      },
    );
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const authenticated = await authenticateApiToken(db, token);
  if (!authenticated) {
    return jsonError("login_required", 401);
  }

  const headers: Record<string, string> = {};
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  const publicOrigin = getCloudBaseUrl().replace(/\/+$/, "");
  const server = createFrameosMcpServer({
    baseUrl: internalOrigin(),
    fetchExternal: (input, init) => guardedFetch(input, init),
    headers,
    publicOrigin,
    storeOrigin: getScenesBaseUrl().replace(/\/+$/, ""),
    token,
    userAgent: `frameos-cloud-mcp (account ${authenticated.account.id})`,
  });
  try {
    return await serveStatelessHttp(server, request);
  } catch (error) {
    logWarn("mcp.request_failed", { message: String(error) });
    return jsonError("mcp_failed", 500);
  }
}

export function GET() {
  return jsonError("method_not_allowed", 405, {
    hint: "This MCP endpoint is stateless: POST JSON-RPC requests only.",
  });
}

export function DELETE() {
  return jsonError("method_not_allowed", 405);
}

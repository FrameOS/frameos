import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createDb, deviceAuthorizationRequests } from "@frameos-cloud/db";
import { allowedDeviceScopes, defaultDeviceScopes } from "./device-scopes";
import { getAccountBaseUrl, hasDatabaseUrl } from "./env";
import { hashUserCode } from "./secrets";

export {
  allowedDeviceScopes,
  defaultDeviceScopes,
  deviceScopeDescriptions,
} from "./device-scopes";

const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function jsonError(
  error: string,
  status: number,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json({ error, ...extra }, { status });
}

export function requireDatabase() {
  if (!hasDatabaseUrl()) {
    return {
      db: undefined,
      response: jsonError("database_not_configured", 503),
    };
  }

  return {
    db: createDb(),
    response: undefined,
  };
}

export async function readJsonObject(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function normalizeUserCode(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function formatUserCode(value: string) {
  const normalized = normalizeUserCode(value).slice(0, 8);
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

// Stored/display form that keeps only the first half of the code. The full
// code must never be persisted in plaintext: combined with the user_code_hash
// it would let a database reader race the user and approve pending requests.
export function maskUserCode(value: string) {
  const normalized = normalizeUserCode(value).slice(0, 8);
  return `${normalized.slice(0, 4)}-****`;
}

export async function generateUniqueUserCode(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const raw = Array.from({ length: 8 }, () => {
      const index = randomInt(userCodeAlphabet.length);
      return userCodeAlphabet[index];
    }).join("");
    const display = formatUserCode(raw);
    const [existing] = await db
      .select({ id: deviceAuthorizationRequests.id })
      .from(deviceAuthorizationRequests)
      .where(
        eq(
          deviceAuthorizationRequests.userCodeHash,
          hashUserCode(normalizeUserCode(display)),
        ),
      )
      .limit(1);

    if (!existing) {
      return display;
    }
  }

  throw new Error("Failed to generate a unique device authorization user code");
}

export function deviceVerificationUrls(userCode: string) {
  const verificationUri = new URL("/device", getAccountBaseUrl());
  const verificationUriComplete = new URL(verificationUri);
  verificationUriComplete.searchParams.set("user_code", userCode);

  return {
    verification_uri: verificationUri.toString(),
    verification_uri_complete: verificationUriComplete.toString(),
  };
}

export function parseString(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function parseOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Hosts a self-hosted FrameOS install can plausibly live on: this machine, a
// private network, or an mDNS name. Anything else is somewhere on the public
// internet, which a local install is not.
export function isLocalHostname(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  // IPv6 literals only: loopback, link-local and unique-local. The prefix
  // tests must never run against a DNS name — "fdcloud.example.com" starts
  // with "fd" too, and this allowlist decides where login codes may be sent.
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host.startsWith("fe80:") ||
      /^f[cd][0-9a-f]{2}:/.test(host)
    );
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = octets;
  if (a === 127 || a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

// The backend's reported local address. device/start is unauthenticated, so
// this is entirely attacker-supplied, and it is not merely decoration: it is
// shown to the approving user as "Request from", it is the allowlist for the
// login handoff's redirect_uri, and the approval screen will navigate the
// browser back to it. Despite the name it used to accept any public origin,
// so a request claiming to come from "https://frameos.example.com" looked as
// legitimate on the consent screen as a real one — and then received login
// codes. Restricted to addresses a local install can actually have.
export function safeLocalOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    if (!isLocalHostname(url.hostname)) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

// "backend" is a FrameOS backend install; "frame" is a frame that links
// directly, without a backend. An explicit client_kind wins; otherwise the
// kind is derived from the base scope the client requested.
export function parseClientKind(
  value: unknown,
  scopes: string[],
): "backend" | "frame" {
  if (value === "backend" || value === "frame") {
    return value;
  }

  return scopes.includes("frame:link") ? "frame" : "backend";
}

export function parseScopes(value: unknown) {
  if (!Array.isArray(value)) {
    return defaultDeviceScopes;
  }

  const scopes = value
    .filter((scope): scope is string => typeof scope === "string")
    .map((scope) => scope.trim())
    .filter((scope) => allowedDeviceScopes.has(scope));

  return scopes.length > 0 ? scopes : defaultDeviceScopes;
}

export function metadataFromBody(body: Record<string, unknown>) {
  return {
    capabilities: body.capabilities,
    reportedFrameosVersion: parseOptionalString(body.reported_frameos_version),
  };
}

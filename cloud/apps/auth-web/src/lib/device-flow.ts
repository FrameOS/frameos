import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createDb, deviceAuthorizationRequests } from "@frameos-cloud/db";
import { allowedDeviceScopes, defaultDeviceScopes } from "./device-scopes";
import { getAccountBaseUrl, hasDatabaseUrl } from "./env";
import { hashSecret } from "./secrets";

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
          hashSecret(normalizeUserCode(display)),
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

// Accept only a well-formed http(s) origin for the backend's reported local
// address. The value is attacker-supplied (device/start is unauthenticated) and
// is later shown to the approving user, so reject anything that isn't a clean
// origin to avoid storing phishing-friendly junk.
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

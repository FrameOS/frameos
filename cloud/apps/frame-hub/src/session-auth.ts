// Browser-socket auth: verify the auth-web session cookie without Next.
// Replicates cloud/apps/auth-web/src/lib/session.ts (the source of truth for
// cookie naming and verification): an HS256 JWT signed with
// derivedSigningKey("session"), valid only while its sessions row (keyed by
// the sha256-base64url token hash) is unrevoked and unexpired.
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { jwtVerify } from "jose";
import { createDb, sessions } from "@frameos-cloud/db";
import { derivedSigningKey } from "../../auth-web/src/lib/keys";
import { hashSecret } from "../../auth-web/src/lib/secrets";
import { isRecord } from "./protocol";

// Cookie names as minted by auth-web: dev uses the bare name, single-origin
// production uses __Host-, split-domain production uses __Secure-. The hub
// simply tries every candidate so it needs no knowledge of which deployment
// mode auth-web is in.
export const sessionCookieCandidates = [
  "__Host-frameos_cloud_session",
  "__Secure-frameos_cloud_session",
  "frameos_cloud_session",
];

export function parseCookieHeader(
  header: string | undefined,
): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name || cookies.has(name)) {
      continue;
    }
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
}

// The authenticated browser session behind an upgrade. tokenHash is kept so
// the hub can recheck revocation later: sockets outlive the upgrade, and a
// session revoked afterwards (logout, admin revoke) must stop streaming.
export interface BrowserSession {
  accountId: string;
  tokenHash: string;
}

export async function verifySessionToken(
  db: ReturnType<typeof createDb>,
  token: string,
): Promise<BrowserSession | undefined> {
  try {
    const verified = await jwtVerify(token, derivedSigningKey("session"), {
      algorithms: ["HS256"],
    });
    const profile = verified.payload.profile;
    if (!isRecord(profile) || typeof profile.accountId !== "string") {
      return undefined;
    }
    const accountId = profile.accountId;
    const tokenHash = hashSecret(token);
    const [row] = await db
      .select({
        accountId: sessions.accountId,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    if (
      !row ||
      row.revokedAt ||
      row.expiresAt <= new Date() ||
      row.accountId !== accountId
    ) {
      return undefined;
    }
    return { accountId, tokenHash };
  } catch {
    return undefined;
  }
}

// Resolves the signed-in account behind a browser upgrade request, or
// undefined when there is no valid session.
export async function authenticateBrowserSession(
  db: ReturnType<typeof createDb>,
  cookieHeader: string | undefined,
): Promise<BrowserSession | undefined> {
  const cookies = parseCookieHeader(cookieHeader);
  for (const name of sessionCookieCandidates) {
    const token = cookies.get(name);
    if (!token) {
      continue;
    }
    const session = await verifySessionToken(db, token);
    if (session) {
      return session;
    }
  }
  return undefined;
}

// The subset of the given session token hashes that are still live. Used by
// the sweep to close browser sockets whose session was revoked or expired
// after the upgrade — devices are kicked on revocation, browsers must be too.
export async function liveSessionHashes(
  db: ReturnType<typeof createDb>,
  tokenHashes: string[],
): Promise<Set<string>> {
  if (tokenHashes.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(
      and(
        inArray(sessions.tokenHash, tokenHashes),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  return new Set(rows.map((row) => row.tokenHash));
}

import { and, eq, isNull } from "drizzle-orm";
import { accountApiTokens, accounts, type createDb } from "@frameos-cloud/db";
import { createSecretToken, hashSecret } from "./secrets";

// Personal API tokens: the account, as a bearer. Minted on /account/developer
// (or POST /api/account/api-tokens), shown once, stored hashed, and accepted
// by readSession() wherever a session cookie is — which makes every JSON route
// and the MCP server at /api/mcp usable from a script or an agent without a
// browser. The three sudo-mode routes (frame revoke, link revoke, device
// approval) read the session COOKIE's freshness and therefore stay closed to
// tokens; so do the 2FA routes, which demand a live proof in the body.
//
// Two kinds, told apart by prefix so the CSRF gate can refuse a mutation
// before any database work: `fc_api_…` may do everything the account may,
// `fc_apiro_…` only GET. The database row is still the authority — a token
// whose row says read_only is refused for mutations even if someone forged
// the prefix, and vice versa.

export const apiTokenPrefix = "fc_api";
export const apiTokenReadOnlyPrefix = "fc_apiro";
export const apiTokenAccessValues = ["full", "read_only"] as const;
export type ApiTokenAccess = (typeof apiTokenAccessValues)[number];

export const maxApiTokensPerAccount = 25;
export const maxApiTokenNameLength = 64;
export const maxApiTokenTtlDays = 365;

// Recent use is recorded at most this often; the column is for "is this
// token still in use", not an access log.
const lastUsedWriteIntervalMs = 60 * 1000;

export type ApiTokenIdentity = {
  access: ApiTokenAccess;
  id: string;
  name: string;
};

export function bearerToken(authorization: string | null | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function isApiToken(token: string | undefined): token is string {
  return (
    typeof token === "string" &&
    (token.startsWith(`${apiTokenPrefix}_`) ||
      token.startsWith(`${apiTokenReadOnlyPrefix}_`))
  );
}

export function apiTokenAccessFromPrefix(token: string): ApiTokenAccess {
  return token.startsWith(`${apiTokenReadOnlyPrefix}_`) ? "read_only" : "full";
}

export function mintApiToken(access: ApiTokenAccess) {
  const token = createSecretToken(
    access === "read_only" ? apiTokenReadOnlyPrefix : apiTokenPrefix,
    32,
  );
  return { hint: tokenHint(token), token, tokenHash: hashSecret(token) };
}

// Prefix plus the first four random characters. Computed from the known
// prefix length, not by searching for "_": base64url output contains
// underscores of its own.
export function tokenHint(token: string) {
  const prefix = token.startsWith(`${apiTokenReadOnlyPrefix}_`)
    ? apiTokenReadOnlyPrefix
    : apiTokenPrefix;
  return token.slice(0, prefix.length + 1 + 4);
}

export type AuthenticatedApiToken = {
  account: { email: string | null; id: string; name: string | null };
  token: ApiTokenIdentity;
};

// Resolves a raw bearer to its account, or undefined for anything that is not
// a live token. Stamps last_used_at (throttled) as a side effect.
export async function authenticateApiToken(
  db: ReturnType<typeof createDb>,
  token: string,
): Promise<AuthenticatedApiToken | undefined> {
  if (!isApiToken(token)) {
    return undefined;
  }
  const [row] = await db
    .select({
      access: accountApiTokens.access,
      accountId: accountApiTokens.accountId,
      email: accounts.primaryEmail,
      expiresAt: accountApiTokens.expiresAt,
      id: accountApiTokens.id,
      lastUsedAt: accountApiTokens.lastUsedAt,
      name: accountApiTokens.name,
      accountName: accounts.displayName,
    })
    .from(accountApiTokens)
    .innerJoin(accounts, eq(accounts.id, accountApiTokens.accountId))
    .where(
      and(
        eq(accountApiTokens.tokenHash, hashSecret(token)),
        isNull(accountApiTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) {
    return undefined;
  }
  const now = new Date();
  if (row.expiresAt && row.expiresAt <= now) {
    return undefined;
  }
  const access = row.access === "read_only" ? "read_only" : "full";
  if (access !== apiTokenAccessFromPrefix(token)) {
    return undefined;
  }
  if (
    !row.lastUsedAt ||
    now.getTime() - row.lastUsedAt.getTime() > lastUsedWriteIntervalMs
  ) {
    await db
      .update(accountApiTokens)
      .set({ lastUsedAt: now })
      .where(eq(accountApiTokens.id, row.id));
  }
  return {
    account: { email: row.email, id: row.accountId, name: row.accountName },
    token: { access, id: row.id, name: row.name },
  };
}

export function serializeApiToken(row: {
  access: string;
  createdAt: Date;
  expiresAt: Date | null;
  id: string;
  lastUsedAt: Date | null;
  name: string;
  revokedAt: Date | null;
  tokenHint: string;
}) {
  return {
    access: row.access === "read_only" ? "read_only" : "full",
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
    id: row.id,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    name: row.name,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    token_hint: row.tokenHint,
  };
}

export async function listApiTokens(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const rows = await db
    .select()
    .from(accountApiTokens)
    .where(
      and(
        eq(accountApiTokens.accountId, accountId),
        isNull(accountApiTokens.revokedAt),
      ),
    )
    .orderBy(accountApiTokens.createdAt);
  return rows.map(serializeApiToken);
}

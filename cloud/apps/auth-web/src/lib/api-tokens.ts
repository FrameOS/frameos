import { and, eq, isNull, sql } from "drizzle-orm";
import {
  accountApiTokens,
  accountIdentities,
  accounts,
  type createDb,
} from "@frameos-cloud/db";
import { createSecretToken, hashSecret } from "./secrets";

// Personal API tokens: the account, as a bearer. Minted on /account/developer
// (or POST /api/account/api-tokens), shown once, stored hashed, and accepted
// by readSession() wherever a session cookie is — which makes every JSON route
// and the MCP server at /api/mcp usable from a script or an agent without a
// browser. The three sudo-mode routes (frame revoke, link revoke, device
// approval) read the session COOKIE's freshness and therefore stay closed to
// tokens; so do the 2FA routes, which demand a live proof in the body.
//
// Three kinds, told apart by prefix so the CSRF gate can refuse a mutation
// before any database work: `fc_api_…` may do everything the account may,
// `fc_apiro_…` only GET, and `fc_apijob_…` is a JOB token — it satisfies no
// `readSession()` gate at all and is accepted by exactly one route, the one
// its access value names (today: `billing_nightly`, the accounting cron).
// The database row is still the authority — a token whose row says
// read_only is refused for mutations even if someone forged the prefix, and
// vice versa.
//
// Job tokens exist so that a cron job never holds a person-shaped
// credential: the nightly accounting sweep used to run on a superadmin's
// `fc_api_` token, which could also read every account, post journal
// entries and grant superadmin from the ops box. A `billing_nightly` token
// can call `POST /api/admin/billing/nightly` and nothing else, and the
// account it belongs to needs no superadmin flag. They are minted only by
// `scripts/accounting-service-account.sh`, never by the token route.

export const apiTokenPrefix = "fc_api";
export const apiTokenReadOnlyPrefix = "fc_apiro";
export const apiTokenJobPrefix = "fc_apijob";
// What a person may mint on /account/developer.
export const apiTokenAccessValues = ["full", "read_only"] as const;
export type ApiTokenAccess = (typeof apiTokenAccessValues)[number];
// What a job token's row may say; each value names the one route it opens.
export const jobTokenAccessValues = ["billing_nightly"] as const;
export type JobTokenAccess = (typeof jobTokenAccessValues)[number];
export type AnyApiTokenAccess = ApiTokenAccess | JobTokenAccess;

export const maxApiTokensPerAccount = 25;
export const maxApiTokenNameLength = 64;
export const maxApiTokenTtlDays = 365;
// Every token expires. A token minted "forever" outlives the laptop it was
// pasted into and the reason it was made; ninety days is long enough for a
// script that is actually in use (its owner re-mints from the page, which
// asks for fresh credentials) and short enough that a forgotten one dies on
// its own. The route applies this when `expires_in_days` is omitted and
// refuses an explicit `null`.
export const defaultApiTokenTtlDays = 90;

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
      token.startsWith(`${apiTokenReadOnlyPrefix}_`) ||
      token.startsWith(`${apiTokenJobPrefix}_`))
  );
}

export function isJobToken(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(`${apiTokenJobPrefix}_`);
}

// The kind the prefix claims. A job prefix maps to the job access family;
// which job it is comes from the row (authenticateJobToken checks it).
export function apiTokenAccessFromPrefix(
  token: string,
): "full" | "read_only" | "job" {
  if (token.startsWith(`${apiTokenReadOnlyPrefix}_`)) {
    return "read_only";
  }
  if (token.startsWith(`${apiTokenJobPrefix}_`)) {
    return "job";
  }
  return "full";
}

function accessMatchesPrefix(token: string, access: AnyApiTokenAccess) {
  const kind = apiTokenAccessFromPrefix(token);
  return kind === "job"
    ? (jobTokenAccessValues as readonly string[]).includes(access)
    : kind === access;
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
    : token.startsWith(`${apiTokenJobPrefix}_`)
      ? apiTokenJobPrefix
      : apiTokenPrefix;
  return token.slice(0, prefix.length + 1 + 4);
}

export type AuthenticatedApiToken = {
  account: {
    email: string | null;
    emailVerified: boolean;
    id: string;
    name: string | null;
  };
  token: ApiTokenIdentity;
};

// Resolves a raw PERSONAL bearer (`fc_api_` / `fc_apiro_`) to its account, or
// undefined for anything that is not a live token — a job token included:
// readSession() must never see one as a person. Stamps last_used_at
// (throttled) as a side effect.
export async function authenticateApiToken(
  db: ReturnType<typeof createDb>,
  token: string,
): Promise<AuthenticatedApiToken | undefined> {
  if (!isApiToken(token) || isJobToken(token)) {
    return undefined;
  }
  const authenticated = await authenticateAnyToken(db, token);
  if (!authenticated || authenticated.token.access === "billing_nightly") {
    return undefined;
  }
  return {
    account: authenticated.account,
    token: {
      access: authenticated.token.access,
      id: authenticated.token.id,
      name: authenticated.token.name,
    },
  };
}

// Resolves the `Authorization` header of a request to a live JOB token whose
// row says `access`, or undefined. The one door a job token opens; the route
// that owns the job calls this instead of readSession(). Nothing about the
// account is returned — a job is not a person, and the route must not act as
// one.
export async function authenticateJobToken(
  db: ReturnType<typeof createDb>,
  authorization: string | null | undefined,
  access: JobTokenAccess,
): Promise<
  | { accountId: string; token: { access: JobTokenAccess; id: string; name: string } }
  | undefined
> {
  const token = bearerToken(authorization);
  if (!isJobToken(token)) {
    return undefined;
  }
  const authenticated = await authenticateAnyToken(db, token);
  if (!authenticated || authenticated.token.access !== access) {
    return undefined;
  }
  return {
    accountId: authenticated.account.id,
    token: { access, id: authenticated.token.id, name: authenticated.token.name },
  };
}

type AuthenticatedAnyToken = {
  account: AuthenticatedApiToken["account"];
  token: { access: AnyApiTokenAccess; id: string; name: string };
};

async function authenticateAnyToken(
  db: ReturnType<typeof createDb>,
  token: string,
): Promise<AuthenticatedAnyToken | undefined> {
  const [row] = await db
    .select({
      access: accountApiTokens.access,
      accountId: accountApiTokens.accountId,
      email: accounts.primaryEmail,
      // Same question a cookie session answers from its identity row: does
      // any identity on the account vouch for the address?
      emailVerified: sql<boolean>`exists (
        select 1 from ${accountIdentities}
        where ${accountIdentities.accountId} = ${accounts.id}
          and ${accountIdentities.emailVerified}
      )`,
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
  const access = readTokenAccess(row.access);
  if (!access || !accessMatchesPrefix(token, access)) {
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
    account: {
      email: row.email,
      emailVerified: row.emailVerified === true,
      id: row.accountId,
      name: row.accountName,
    },
    token: { access, id: row.id, name: row.name },
  };
}

// The row's `access` column, or undefined for a value no code ever wrote.
function readTokenAccess(value: string): AnyApiTokenAccess | undefined {
  return (apiTokenAccessValues as readonly string[]).includes(value) ||
    (jobTokenAccessValues as readonly string[]).includes(value)
    ? (value as AnyApiTokenAccess)
    : undefined;
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
    access: readTokenAccess(row.access) ?? "full",
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

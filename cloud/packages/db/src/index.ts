import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import {
  accountApiTokens,
  accountIdentities,
  accounts,
  auditEvents,
  sessions,
} from "./schema";

export * from "./schema";

// First-party password identities are rows in account_identities so account
// lookup stays keyed on (provider_issuer, provider_subject) for every sign-in
// method. The subject is the normalized email, which makes it unique.
export const passwordProviderIssuer = "frameos-cloud";
export const passwordProviderKey = "password";
export const googleProviderKey = "google";
export const appleProviderKey = "apple";
// The sign-in providers that vouch for an email address: an account that
// joined through one of them has no password until a reset adds one.
export const socialProviderKeys = [googleProviderKey, appleProviderKey] as const;
export type SocialProviderKey = (typeof socialProviderKeys)[number];

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

type Database = ReturnType<typeof drizzle<typeof schema>>;

// Next's dev server re-evaluates its server modules on every hot reload, so a
// module-level Map would give each generation of this module its own cache —
// and postgres.js keeps every earlier generation's pool open for good. A day
// of editing then walks the connection count up five at a time until Postgres
// answers "sorry, too many clients already" and every page 500s. The process's
// globalThis outlives those reloads, so keep the one cache there.
const cacheHolder = globalThis as typeof globalThis & {
  __frameosCloudDbClients?: Map<string, Database>;
};
const clientCache = (cacheHolder.__frameosCloudDbClients ??=
  new Map<string, Database>());

export interface CreateDbOptions {
  // Test seam: called with the text of every statement the pool sends. A
  // client with an observer is NOT cached — it is the caller's own pool, to
  // be ended by the caller — so the observer never leaks into the shared
  // client other modules get for the same URL.
  onQuery?: (query: string) => void;
}

export function createDb(
  databaseUrl = process.env.DATABASE_URL,
  options: CreateDbOptions = {},
) {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to create the FrameOS Cloud database client",
    );
  }

  // postgres.js holds its pool open until `.end()` is called, so creating a new
  // client per request would leak connections until Postgres refuses new ones.
  // Cache one pooled client per connection string and reuse it.
  const cached = options.onQuery ? undefined : clientCache.get(databaseUrl);
  if (cached) {
    return cached;
  }

  // postgres.js defaults to no TLS. Local development talks to a localhost
  // socket, but any deployment where Postgres is on another host must set
  // DATABASE_SSL=require (or put sslmode=require in DATABASE_URL).
  const ssl = process.env.DATABASE_SSL;
  const { onQuery } = options;
  const client = postgres(databaseUrl, {
    max: parsePoolMax(process.env.DATABASE_POOL_MAX),
    ...(ssl === "require" || ssl === "true" ? { ssl: "require" as const } : {}),
    ...(onQuery
      ? { debug: (_connection: number, query: string) => onQuery(query) }
      : {}),
  });
  const db = drizzle(client, { schema });
  if (!onQuery) {
    clientCache.set(databaseUrl, db);
  }
  return db;
}

// 5 connections suit a single dev instance; production deployments size the
// pool via DATABASE_POOL_MAX based on replica count and Postgres limits.
function parsePoolMax(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
}

// Returns the account id plus `created`: true when this call inserted a brand
// new account, false when the identity already existed. Callers use the flag
// to trigger signup-only side effects (notifications) without firing them on
// every sign-in.
export async function upsertAccountFromIdentity(
  db: ReturnType<typeof createDb>,
  identity: {
    displayName?: string | undefined;
    email?: string | undefined;
    emailVerified?: boolean | undefined;
    providerIssuer: string;
    providerKey: string;
    providerSubject: string;
  },
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        accountDisplayName: accounts.displayName,
        accountId: accountIdentities.accountId,
        accountPrimaryEmail: accounts.primaryEmail,
        emailSnapshot: accountIdentities.emailSnapshot,
        emailVerified: accountIdentities.emailVerified,
        id: accountIdentities.id,
      })
      .from(accountIdentities)
      .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
      .where(
        and(
          eq(accountIdentities.providerIssuer, identity.providerIssuer),
          eq(accountIdentities.providerSubject, identity.providerSubject),
        ),
      )
      .limit(1);

    if (existing) {
      // The identity row follows the provider: its address, and whether the
      // provider vouches for it, is what lookups by email compare against.
      const now = new Date();
      await tx
        .update(accountIdentities)
        .set({
          emailSnapshot: identity.email ?? existing.emailSnapshot,
          emailVerified: identity.emailVerified ?? existing.emailVerified,
          updatedAt: now,
        })
        .where(eq(accountIdentities.id, existing.id));

      // The account's own name and address do not: a sign-in is not a
      // request to change them, and overwriting them on every Google sign-in
      // left a password account linked to Google with its password address,
      // its Google address and a primary address that was whichever signed
      // in last. Only an address that came from this identity follows a
      // changed provider address; a missing name or address is filled in.
      const addressFollowsIdentity =
        !existing.accountPrimaryEmail ||
        (existing.emailSnapshot !== null &&
          existing.accountPrimaryEmail.toLowerCase() ===
            existing.emailSnapshot.toLowerCase());
      await tx
        .update(accounts)
        .set({
          displayName: existing.accountDisplayName || identity.displayName,
          primaryEmail: addressFollowsIdentity
            ? (identity.email ?? existing.accountPrimaryEmail)
            : existing.accountPrimaryEmail,
          updatedAt: now,
        })
        .where(eq(accounts.id, existing.accountId));
      return { accountId: existing.accountId, created: false };
    }

    const [account] = await tx
      .insert(accounts)
      .values({
        displayName: identity.displayName,
        primaryEmail: identity.email,
      })
      .returning({ accountId: accounts.id });

    if (!account) {
      throw new Error("Failed to create FrameOS Cloud account");
    }

    await tx.insert(accountIdentities).values({
      accountId: account.accountId,
      emailSnapshot: identity.email,
      emailVerified: identity.emailVerified ?? false,
      providerIssuer: identity.providerIssuer,
      providerKey: identity.providerKey,
      providerSubject: identity.providerSubject,
    });

    return { accountId: account.accountId, created: true };
  });
}

export async function findIdentity(
  db: ReturnType<typeof createDb>,
  providerIssuer: string,
  providerSubject: string,
) {
  const [identity] = await db
    .select({
      accountId: accountIdentities.accountId,
      emailVerified: accountIdentities.emailVerified,
      id: accountIdentities.id,
    })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.providerIssuer, providerIssuer),
        eq(accountIdentities.providerSubject, providerSubject),
      ),
    )
    .limit(1);
  return identity;
}

export async function findAccountByPasswordEmail(
  db: ReturnType<typeof createDb>,
  email: string,
) {
  const [row] = await db
    .select({
      displayName: accounts.displayName,
      emailVerified: accountIdentities.emailVerified,
      id: accounts.id,
      isSuperadmin: accounts.isSuperadmin,
      passwordHash: accounts.passwordHash,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accountIdentities)
    .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(
      and(
        eq(accountIdentities.providerIssuer, passwordProviderIssuer),
        eq(accountIdentities.providerSubject, normalizeEmail(email)),
      ),
    )
    .limit(1);
  return row;
}

export async function createPasswordAccount(
  db: ReturnType<typeof createDb>,
  input: {
    displayName?: string | undefined;
    email: string;
    passwordHash: string;
  },
) {
  const email = normalizeEmail(input.email);
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        primaryEmail: email,
      })
      .returning({ accountId: accounts.id });

    if (!account) {
      throw new Error("Failed to create FrameOS Cloud account");
    }

    // The unique index on (provider_issuer, provider_subject) makes concurrent
    // signups for the same email fail here and roll the transaction back.
    await tx.insert(accountIdentities).values({
      accountId: account.accountId,
      emailSnapshot: email,
      emailVerified: false,
      providerIssuer: passwordProviderIssuer,
      providerKey: passwordProviderKey,
      providerSubject: email,
    });

    return account;
  });
}

// Finds the account behind a Google or Apple identity whose
// provider-attested email matches: signup refuses to plant a password on it,
// the reset flow adds its first one, and a sign-in through the other provider
// is pointed at it instead of making a second account. Only verified emails
// count: an unverified snapshot proves nothing. The snapshot is compared
// case-insensitively, since providers keep the case people typed.
export async function findVerifiedSocialAccountByEmail(
  db: ReturnType<typeof createDb>,
  email: string,
  providers: readonly SocialProviderKey[] = socialProviderKeys,
) {
  const [row] = await db
    .select({
      accountId: accountIdentities.accountId,
      providerKey: accountIdentities.providerKey,
    })
    .from(accountIdentities)
    .where(
      and(
        inArray(accountIdentities.providerKey, [...providers]),
        eq(accountIdentities.emailVerified, true),
        sql`lower(${accountIdentities.emailSnapshot}) = ${normalizeEmail(email)}`,
      ),
    )
    .limit(1);
  return row
    ? {
        accountId: row.accountId,
        providerKey: row.providerKey as SocialProviderKey,
      }
    : undefined;
}

export async function findVerifiedGoogleAccountByEmail(
  db: ReturnType<typeof createDb>,
  email: string,
) {
  return findVerifiedSocialAccountByEmail(db, email, [googleProviderKey]);
}

// Called when a password reset completes: the emailed link was followed, so
// the address is proven. Marks an existing password identity verified, or —
// for a Google-first account gaining its first password — creates the
// password identity outright, already verified.
export async function ensurePasswordIdentityForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const [existing] = await db
    .select({ id: accountIdentities.id })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.accountId, accountId),
        eq(accountIdentities.providerIssuer, passwordProviderIssuer),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(accountIdentities)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(accountIdentities.id, existing.id));
    return;
  }

  const [socialIdentity] = await db
    .select({ emailSnapshot: accountIdentities.emailSnapshot })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.accountId, accountId),
        inArray(accountIdentities.providerKey, [...socialProviderKeys]),
        eq(accountIdentities.emailVerified, true),
      ),
    )
    .limit(1);

  if (!socialIdentity?.emailSnapshot) {
    return;
  }

  const email = normalizeEmail(socialIdentity.emailSnapshot);
  await db.insert(accountIdentities).values({
    accountId,
    emailSnapshot: email,
    emailVerified: true,
    providerIssuer: passwordProviderIssuer,
    providerKey: passwordProviderKey,
    providerSubject: email,
  });
}

export async function linkIdentityToAccount(
  db: ReturnType<typeof createDb>,
  identity: {
    accountId: string;
    email?: string | undefined;
    emailVerified?: boolean | undefined;
    providerIssuer: string;
    providerKey: string;
    providerSubject: string;
  },
) {
  await db.insert(accountIdentities).values({
    accountId: identity.accountId,
    emailSnapshot: identity.email,
    emailVerified: identity.emailVerified ?? false,
    providerIssuer: identity.providerIssuer,
    providerKey: identity.providerKey,
    providerSubject: identity.providerSubject,
  });
}

// Apple's refresh token for an identity, already sealed by the caller
// (migration 0077): the newest one replaces the last.
export async function setIdentityProviderToken(
  db: ReturnType<typeof createDb>,
  providerIssuer: string,
  providerSubject: string,
  providerTokenEncrypted: string,
) {
  await db
    .update(accountIdentities)
    .set({ providerTokenEncrypted, updatedAt: new Date() })
    .where(
      and(
        eq(accountIdentities.providerIssuer, providerIssuer),
        eq(accountIdentities.providerSubject, providerSubject),
      ),
    );
}

// Every sealed provider token an account holds, for revoking them before the
// account is deleted.
export async function accountProviderTokens(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  return db
    .select({
      providerKey: accountIdentities.providerKey,
      providerTokenEncrypted: accountIdentities.providerTokenEncrypted,
    })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.accountId, accountId),
        isNotNull(accountIdentities.providerTokenEncrypted),
      ),
    );
}

// The social providers an account signs in with (Google, Apple): what
// /login/reauth offers an account that has nothing local to check.
export async function accountSocialProviders(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<SocialProviderKey[]> {
  const rows = await db
    .select({ providerKey: accountIdentities.providerKey })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.accountId, accountId),
        inArray(accountIdentities.providerKey, [...socialProviderKeys]),
      ),
    );
  return socialProviderKeys.filter((key) =>
    rows.some((row) => row.providerKey === key),
  );
}

export async function setAccountPassword(
  db: ReturnType<typeof createDb>,
  accountId: string,
  passwordHash: string,
) {
  await db
    .update(accounts)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
}

export async function markPasswordIdentityVerified(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  await db
    .update(accountIdentities)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(
      and(
        eq(accountIdentities.accountId, accountId),
        eq(accountIdentities.providerIssuer, passwordProviderIssuer),
      ),
    );
}

export async function revokeSessionsForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
}

// Personal API tokens are the account's other bearer credential. Anything
// that evicts every session because the account may be compromised (a
// password reset, an admin "sign out everywhere") must evict them too, or the
// attacker keeps a script-shaped foothold that outlives the reset. The same
// goes for enrolling a second factor: a token minted before 2FA was on
// would otherwise keep bypassing it. Returns how many were live.
export async function revokeApiTokensForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const revoked = await db
    .update(accountApiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accountApiTokens.accountId, accountId),
        isNull(accountApiTokens.revokedAt),
      ),
    )
    .returning({ id: accountApiTokens.id });
  return revoked.length;
}

export async function recordAuditEvent(
  db: ReturnType<typeof createDb>,
  event: {
    accountId?: string | undefined;
    actor: unknown;
    eventType: string;
    metadata?: unknown;
    target?: unknown;
  },
) {
  await db.insert(auditEvents).values({
    accountId: event.accountId,
    actor: event.actor,
    eventType: event.eventType,
    metadata: event.metadata,
    target: event.target,
  });
}

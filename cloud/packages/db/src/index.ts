import { and, eq, isNull } from "drizzle-orm";
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

export function createDb(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to create the FrameOS Cloud database client",
    );
  }

  // postgres.js holds its pool open until `.end()` is called, so creating a new
  // client per request would leak connections until Postgres refuses new ones.
  // Cache one pooled client per connection string and reuse it.
  const cached = clientCache.get(databaseUrl);
  if (cached) {
    return cached;
  }

  // postgres.js defaults to no TLS. Local development talks to a localhost
  // socket, but any deployment where Postgres is on another host must set
  // DATABASE_SSL=require (or put sslmode=require in DATABASE_URL).
  const ssl = process.env.DATABASE_SSL;
  const client = postgres(databaseUrl, {
    max: parsePoolMax(process.env.DATABASE_POOL_MAX),
    ...(ssl === "require" || ssl === "true" ? { ssl: "require" as const } : {}),
  });
  const db = drizzle(client, { schema });
  clientCache.set(databaseUrl, db);
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
      .select({ accountId: accountIdentities.accountId })
      .from(accountIdentities)
      .where(
        and(
          eq(accountIdentities.providerIssuer, identity.providerIssuer),
          eq(accountIdentities.providerSubject, identity.providerSubject),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(accounts)
        .set({
          displayName: identity.displayName,
          primaryEmail: identity.email,
          updatedAt: new Date(),
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

// Finds the account behind a Google identity whose Google-attested email
// matches, for attaching a password to a Google-first account at signup.
// Only Google-verified emails count: an unverified snapshot proves nothing.
export async function findVerifiedGoogleAccountByEmail(
  db: ReturnType<typeof createDb>,
  email: string,
) {
  const [row] = await db
    .select({ accountId: accountIdentities.accountId })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.providerKey, googleProviderKey),
        eq(accountIdentities.emailSnapshot, normalizeEmail(email)),
        eq(accountIdentities.emailVerified, true),
      ),
    )
    .limit(1);
  return row;
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

  const [googleIdentity] = await db
    .select({ emailSnapshot: accountIdentities.emailSnapshot })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.accountId, accountId),
        eq(accountIdentities.providerKey, googleProviderKey),
        eq(accountIdentities.emailVerified, true),
      ),
    )
    .limit(1);

  if (!googleIdentity?.emailSnapshot) {
    return;
  }

  const email = normalizeEmail(googleIdentity.emailSnapshot);
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
// attacker keeps a script-shaped foothold that outlives the reset.
export async function revokeApiTokensForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  await db
    .update(accountApiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accountApiTokens.accountId, accountId),
        isNull(accountApiTokens.revokedAt),
      ),
    );
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

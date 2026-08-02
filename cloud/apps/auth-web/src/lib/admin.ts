import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  accountIdentities,
  accounts,
  clientBackups,
  createDb,
  linkedClients,
  sessions,
  storeSceneReports,
  storeScenes,
} from "@frameos-cloud/db";
import { hasDatabaseUrl } from "./env";
import { readSession } from "./session";

export type SuperadminContext =
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "ok"; accountId: string };

// Superadmin is checked against the accounts row on every request, not a
// session claim, so revoking the flag takes effect immediately.
export async function getSuperadminContext(): Promise<SuperadminContext> {
  const session = await readSession();
  if (!session?.accountId || !hasDatabaseUrl()) {
    return { kind: "unauthenticated" };
  }

  const [account] = await createDb()
    .select({ isSuperadmin: accounts.isSuperadmin })
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);

  if (!account) {
    return { kind: "unauthenticated" };
  }
  if (!account.isSuperadmin) {
    return { kind: "forbidden" };
  }
  return { accountId: session.accountId, kind: "ok" };
}

export type AdminUserRow = {
  activeSessions: number;
  backupBytes: number;
  backupCount: number;
  createdAt: Date;
  displayName: string | null;
  id: string;
  identities: {
    providerKey: string;
    emailSnapshot: string | null;
    emailVerified: boolean;
  }[];
  isSuperadmin: boolean;
  linkedBackends: number;
  primaryEmail: string | null;
};

export type AdminSceneRow = {
  category: string | null;
  downloadCount: number;
  featuredAt: Date | null;
  id: string;
  latestVersion: number;
  name: string;
  openReports: number;
  ownerBannedAt: Date | null;
  ownerEmail: string | null;
  ownerId: string;
  ownerName: string | null;
  pulledReason: string | null;
  riskFlags: string[];
  slug: string;
  status: string;
  updatedAt: Date;
  visibility: string;
};

// Every scene in the store — including private ones, because moderation has
// to be able to inspect what an account is hosting, not just what it shows.
export async function listScenesForAdmin(
  db: ReturnType<typeof createDb>,
  query?: string,
): Promise<AdminSceneRow[]> {
  const trimmed = query?.trim();
  const filter = trimmed
    ? or(
        ilike(storeScenes.name, `%${trimmed}%`),
        ilike(storeScenes.slug, `%${trimmed}%`),
        ilike(accounts.primaryEmail, `%${trimmed}%`),
      )
    : undefined;

  return db
    .select({
      category: storeScenes.category,
      downloadCount: storeScenes.downloadCount,
      featuredAt: storeScenes.featuredAt,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      openReports: sql<number>`(select count(*) from ${storeSceneReports} where ${storeSceneReports.sceneId} = ${storeScenes.id} and ${storeSceneReports.status} = 'open')::int`,
      ownerBannedAt: accounts.storeBannedAt,
      ownerEmail: accounts.primaryEmail,
      ownerId: accounts.id,
      ownerName: accounts.displayName,
      pulledReason: storeScenes.pulledReason,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      status: storeScenes.status,
      updatedAt: storeScenes.updatedAt,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(filter)
    .orderBy(desc(storeScenes.updatedAt))
    .limit(200);
}

export type AdminReportRow = {
  createdAt: Date;
  id: string;
  reason: string;
  reporterEmail: string | null;
  sceneId: string;
  sceneName: string | null;
  sceneSlug: string | null;
  sceneStatus: string | null;
};

// The open-reports moderation queue, oldest first so nothing rots at the
// bottom. Resolved reports stay in the table for the audit trail but are not
// listed here.
export async function listOpenReportsForAdmin(
  db: ReturnType<typeof createDb>,
): Promise<AdminReportRow[]> {
  return db
    .select({
      createdAt: storeSceneReports.createdAt,
      id: storeSceneReports.id,
      reason: storeSceneReports.reason,
      reporterEmail: accounts.primaryEmail,
      sceneId: storeSceneReports.sceneId,
      sceneName: storeScenes.name,
      sceneSlug: storeScenes.slug,
      sceneStatus: storeScenes.status,
    })
    .from(storeSceneReports)
    .leftJoin(storeScenes, eq(storeScenes.id, storeSceneReports.sceneId))
    .leftJoin(accounts, eq(accounts.id, storeSceneReports.reporterAccountId))
    .where(eq(storeSceneReports.status, "open"))
    .orderBy(storeSceneReports.createdAt)
    .limit(200);
}

export async function listAccountsForAdmin(
  db: ReturnType<typeof createDb>,
  query?: string,
): Promise<AdminUserRow[]> {
  const trimmed = query?.trim();
  const filter = trimmed
    ? or(
        ilike(accounts.primaryEmail, `%${trimmed}%`),
        ilike(accounts.displayName, `%${trimmed}%`),
      )
    : undefined;

  const rows = await db
    .select({
      createdAt: accounts.createdAt,
      displayName: accounts.displayName,
      id: accounts.id,
      isSuperadmin: accounts.isSuperadmin,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(filter)
    .orderBy(desc(accounts.createdAt))
    .limit(200);

  if (rows.length === 0) {
    return [];
  }

  const accountIds = rows.map((row) => row.id);
  const identities = await db
    .select({
      accountId: accountIdentities.accountId,
      emailSnapshot: accountIdentities.emailSnapshot,
      emailVerified: accountIdentities.emailVerified,
      providerKey: accountIdentities.providerKey,
    })
    .from(accountIdentities)
    .where(inArray(accountIdentities.accountId, accountIds));

  const backendCounts = await db
    .select({
      accountId: linkedClients.accountId,
      count: sql<number>`count(*)::int`,
    })
    .from(linkedClients)
    .where(inArray(linkedClients.accountId, accountIds))
    .groupBy(linkedClients.accountId);

  const backupTotals = await db
    .select({
      accountId: clientBackups.accountId,
      bytes: sql<number>`coalesce(sum(${clientBackups.sizeBytes}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(clientBackups)
    .where(inArray(clientBackups.accountId, accountIds))
    .groupBy(clientBackups.accountId);

  const sessionCounts = await db
    .select({
      accountId: sessions.accountId,
      count: sql<number>`count(*)::int`,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.accountId, accountIds),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .groupBy(sessions.accountId);

  const identityMap = new Map<string, AdminUserRow["identities"]>();
  for (const identity of identities) {
    const list = identityMap.get(identity.accountId) ?? [];
    list.push({
      emailSnapshot: identity.emailSnapshot,
      emailVerified: identity.emailVerified,
      providerKey: identity.providerKey,
    });
    identityMap.set(identity.accountId, list);
  }
  const backendMap = new Map(
    backendCounts.map((row) => [row.accountId, row.count]),
  );
  const backupMap = new Map(
    backupTotals.map((row) => [row.accountId, row]),
  );
  const sessionMap = new Map(
    sessionCounts.map((row) => [row.accountId, row.count]),
  );

  return rows.map((row) => ({
    activeSessions: sessionMap.get(row.id) ?? 0,
    backupBytes: backupMap.get(row.id)?.bytes ?? 0,
    backupCount: backupMap.get(row.id)?.count ?? 0,
    createdAt: row.createdAt,
    displayName: row.displayName,
    id: row.id,
    identities: identityMap.get(row.id) ?? [],
    isSuperadmin: row.isSuperadmin,
    linkedBackends: backendMap.get(row.id) ?? 0,
    primaryEmail: row.primaryEmail,
  }));
}

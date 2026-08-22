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
  connectedBackends,
  createDb,
  frames,
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

// "Active vs total" pairs: a backend counts as active until its link is
// revoked; a frame once its enrollment is confirmed (status = active) and
// not revoked. Totals include the revoked rows the owner still sees.
export type ActiveTotal = { active: number; total: number };

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
  frames: ActiveTotal & { connected: number };
  isSuperadmin: boolean;
  backends: ActiveTotal;
  primaryEmail: string | null;
  storeScenes: { public: number; total: number };
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
  ownerVerifiedAt: Date | null;
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
      ownerVerifiedAt: accounts.verifiedPublisherAt,
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

  // linked_clients holds both kinds; a frame's row is counted with the
  // frames below, not here.
  const backendCounts = await db
    .select({
      accountId: linkedClients.accountId,
      active: sql<number>`count(*) filter (where ${linkedClients.revokedAt} is null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(linkedClients)
    .where(
      and(
        inArray(linkedClients.accountId, accountIds),
        eq(linkedClients.clientKind, "backend"),
      ),
    )
    .groupBy(linkedClients.accountId);

  const sceneCounts = await db
    .select({
      accountId: storeScenes.accountId,
      public: sql<number>`count(*) filter (where ${storeScenes.visibility} = 'public' and ${storeScenes.status} = 'active')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(storeScenes)
    .where(inArray(storeScenes.accountId, accountIds))
    .groupBy(storeScenes.accountId);

  const backupTotals = await db
    .select({
      accountId: clientBackups.accountId,
      bytes: sql<number>`coalesce(sum(${clientBackups.sizeBytes}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(clientBackups)
    .where(inArray(clientBackups.accountId, accountIds))
    .groupBy(clientBackups.accountId);

  // Every frame row the user still sees in their workspace counts, revoked
  // included — deletion removes the row outright, so "gone" means gone.
  const frameCounts = await db
    .select({
      accountId: frames.accountId,
      active: sql<number>`count(*) filter (where ${frames.status} = 'active')::int`,
      connected: sql<number>`count(*) filter (where ${frames.connected})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(frames)
    .where(inArray(frames.accountId, accountIds))
    .groupBy(frames.accountId);

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
    backendCounts.map((row) => [row.accountId, row]),
  );
  const sceneMap = new Map(
    sceneCounts.map((row) => [row.accountId, row]),
  );
  const backupMap = new Map(
    backupTotals.map((row) => [row.accountId, row]),
  );
  const sessionMap = new Map(
    sessionCounts.map((row) => [row.accountId, row.count]),
  );
  const frameMap = new Map(
    frameCounts.map((row) => [row.accountId, row]),
  );

  return rows.map((row) => {
    const backends = backendMap.get(row.id);
    const frameRow = frameMap.get(row.id);
    const scenes = sceneMap.get(row.id);
    return {
      activeSessions: sessionMap.get(row.id) ?? 0,
      backends: {
        active: backends?.active ?? 0,
        total: backends?.total ?? 0,
      },
      backupBytes: backupMap.get(row.id)?.bytes ?? 0,
      backupCount: backupMap.get(row.id)?.count ?? 0,
      createdAt: row.createdAt,
      displayName: row.displayName,
      frames: {
        active: frameRow?.active ?? 0,
        connected: frameRow?.connected ?? 0,
        total: frameRow?.total ?? 0,
      },
      id: row.id,
      identities: identityMap.get(row.id) ?? [],
      isSuperadmin: row.isSuperadmin,
      primaryEmail: row.primaryEmail,
      storeScenes: {
        public: scenes?.public ?? 0,
        total: scenes?.total ?? 0,
      },
    };
  });
}

export type AdminOverview = {
  accounts: { superadmins: number; total: number; last7d: number };
  backends: ActiveTotal & { seen24h: number };
  backups: { bytes: number; count: number };
  frames: ActiveTotal & { connected: number; pending: number };
  openReports: number;
  sessions: number;
  storeScenes: { public: number; pulled: number; total: number };
};

// One number per thing the admin pages list. Seven cheap aggregate queries;
// the page is only ever opened by a superadmin.
export async function getAdminOverview(
  db: ReturnType<typeof createDb>,
): Promise<AdminOverview> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [accountRow] = await db
    .select({
      last7d: sql<number>`count(*) filter (where ${accounts.createdAt} > ${weekAgo}::timestamptz)::int`,
      superadmins: sql<number>`count(*) filter (where ${accounts.isSuperadmin})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(accounts);

  const [backendRow] = await db
    .select({
      active: sql<number>`count(*) filter (where ${linkedClients.revokedAt} is null)::int`,
      seen24h: sql<number>`count(*) filter (where ${linkedClients.revokedAt} is null and ${linkedClients.lastSeenAt} > ${dayAgo}::timestamptz)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(linkedClients)
    .where(eq(linkedClients.clientKind, "backend"));

  const [frameRow] = await db
    .select({
      active: sql<number>`count(*) filter (where ${frames.status} = 'active')::int`,
      connected: sql<number>`count(*) filter (where ${frames.connected})::int`,
      pending: sql<number>`count(*) filter (where ${frames.status} = 'pending')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(frames);

  const [backupRow] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${clientBackups.sizeBytes}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(clientBackups);

  const [sceneRow] = await db
    .select({
      public: sql<number>`count(*) filter (where ${storeScenes.visibility} = 'public' and ${storeScenes.status} = 'active')::int`,
      pulled: sql<number>`count(*) filter (where ${storeScenes.status} = 'pulled')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(storeScenes);

  const [reportRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storeSceneReports)
    .where(eq(storeSceneReports.status, "open"));

  const [sessionRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));

  return {
    accounts: {
      last7d: accountRow?.last7d ?? 0,
      superadmins: accountRow?.superadmins ?? 0,
      total: accountRow?.total ?? 0,
    },
    backends: {
      active: backendRow?.active ?? 0,
      seen24h: backendRow?.seen24h ?? 0,
      total: backendRow?.total ?? 0,
    },
    backups: {
      bytes: Number(backupRow?.bytes ?? 0),
      count: backupRow?.count ?? 0,
    },
    frames: {
      active: frameRow?.active ?? 0,
      connected: frameRow?.connected ?? 0,
      pending: frameRow?.pending ?? 0,
      total: frameRow?.total ?? 0,
    },
    openReports: reportRow?.count ?? 0,
    sessions: sessionRow?.count ?? 0,
    storeScenes: {
      public: sceneRow?.public ?? 0,
      pulled: sceneRow?.pulled ?? 0,
      total: sceneRow?.total ?? 0,
    },
  };
}

export type AdminBackendRow = {
  createdAt: Date;
  id: string;
  lastSeenAt: Date | null;
  lastSyncAt: Date | null;
  localOrigin: string | null;
  name: string;
  ownerEmail: string | null;
  ownerId: string;
  ownerName: string | null;
  reportedFrameosVersion: string | null;
  revokedAt: Date | null;
};

// Every linked FrameOS backend across all accounts, most recently seen
// first. Revoked links stay listed (greyed in the table) until the owner
// deletes them.
export async function listBackendsForAdmin(
  db: ReturnType<typeof createDb>,
  query?: string,
): Promise<AdminBackendRow[]> {
  const trimmed = query?.trim();
  const filter = trimmed
    ? or(
        ilike(linkedClients.publicDisplayName, `%${trimmed}%`),
        ilike(linkedClients.localOrigin, `%${trimmed}%`),
        ilike(accounts.primaryEmail, `%${trimmed}%`),
        ilike(accounts.displayName, `%${trimmed}%`),
      )
    : undefined;

  return db
    .select({
      createdAt: linkedClients.createdAt,
      id: linkedClients.id,
      lastSeenAt: linkedClients.lastSeenAt,
      lastSyncAt: connectedBackends.lastSyncAt,
      localOrigin: linkedClients.localOrigin,
      name: linkedClients.publicDisplayName,
      ownerEmail: accounts.primaryEmail,
      ownerId: accounts.id,
      ownerName: accounts.displayName,
      reportedFrameosVersion: connectedBackends.reportedFrameosVersion,
      revokedAt: linkedClients.revokedAt,
    })
    .from(linkedClients)
    .innerJoin(accounts, eq(accounts.id, linkedClients.accountId))
    .leftJoin(
      connectedBackends,
      eq(connectedBackends.linkedClientId, linkedClients.id),
    )
    .where(and(eq(linkedClients.clientKind, "backend"), filter))
    .orderBy(
      sql`${linkedClients.lastSeenAt} desc nulls last`,
      desc(linkedClients.createdAt),
    )
    .limit(200);
}

export type AdminFrameRow = {
  connected: boolean;
  createdAt: Date;
  frameosVersion: string | null;
  hardware: unknown;
  id: string;
  lastSeenAt: Date | null;
  name: string;
  ownerEmail: string | null;
  ownerId: string;
  ownerName: string | null;
  status: string;
};

// Every cloud-managed frame across all accounts: connected ones first, then
// by last contact. Device keys and states are deliberately not selected.
export async function listFramesForAdmin(
  db: ReturnType<typeof createDb>,
  query?: string,
): Promise<AdminFrameRow[]> {
  const trimmed = query?.trim();
  const filter = trimmed
    ? or(
        ilike(frames.name, `%${trimmed}%`),
        ilike(frames.frameosVersion, `%${trimmed}%`),
        ilike(accounts.primaryEmail, `%${trimmed}%`),
        ilike(accounts.displayName, `%${trimmed}%`),
      )
    : undefined;

  return db
    .select({
      connected: frames.connected,
      createdAt: frames.createdAt,
      frameosVersion: frames.frameosVersion,
      hardware: frames.hardware,
      id: frames.id,
      lastSeenAt: frames.lastSeenAt,
      name: frames.name,
      ownerEmail: accounts.primaryEmail,
      ownerId: accounts.id,
      ownerName: accounts.displayName,
      status: frames.status,
    })
    .from(frames)
    .innerJoin(accounts, eq(accounts.id, frames.accountId))
    .where(filter)
    .orderBy(
      desc(frames.connected),
      sql`${frames.lastSeenAt} desc nulls last`,
      desc(frames.createdAt),
    )
    .limit(200);
}

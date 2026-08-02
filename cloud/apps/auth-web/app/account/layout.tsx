import { and, eq, isNull, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  accounts,
  clientBackups,
  createDb,
  linkedClients,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { AccountNav } from "../../src/components/AccountNav";
import { AppShell } from "../../src/components/AppShell";
import { UserIdentifier } from "../../src/components/UserIdentifier";
import { getAccountUrl, getCloudBaseUrl } from "../../src/lib/env";
import { formatBytes } from "../../src/lib/format";
import { readSession } from "../../src/lib/session";

// Shared chrome for all /account pages: sign-in gate, app shell, the account
// header, and the section navigation with each section's headline number as
// a tab badge. Each subpage loads its own data.
export default async function AccountLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await readSession();
  if (!session) {
    const cloudBaseUrl = getCloudBaseUrl();
    const loginUrl = new URL("/login", cloudBaseUrl);
    const canonicalPath = (await headers()).get("x-frameos-account-return-to");
    loginUrl.searchParams.set(
      "return_to",
      canonicalPath?.startsWith("/") && !canonicalPath.startsWith("//")
        ? new URL(canonicalPath, getAccountUrl()).toString()
        : getAccountUrl(),
    );
    redirect(loginUrl.toString());
  }

  let isSuperadmin = false;
  let installCount = 0;
  let sceneCount = 0;
  let backupCount = 0;
  let backupBytes = 0;
  let sceneBytes = 0;

  if (session.accountId) {
    const accountId = session.accountId;
    const db = createDb();
    const [[row], installs, scenes, backups, sceneVersionSizes, sceneImageSizes] =
      await Promise.all([
        db
          .select({ isSuperadmin: accounts.isSuperadmin })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(linkedClients)
          .where(
            and(
              eq(linkedClients.accountId, accountId),
              isNull(linkedClients.revokedAt),
            ),
          ),
        db
          .select({
            count: sql<number>`count(*)::int`,
            previewBytes: sql<number>`coalesce(sum(octet_length(${storeScenes.previewImage})), 0)::float8`,
          })
          .from(storeScenes)
          .where(eq(storeScenes.accountId, accountId)),
        db
          .select({
            bytes: sql<number>`coalesce(sum(${clientBackups.sizeBytes}), 0)::float8`,
            count: sql<number>`count(*)::int`,
          })
          .from(clientBackups)
          .where(eq(clientBackups.accountId, accountId)),
        db
          .select({
            bytes: sql<number>`coalesce(sum(${storeSceneVersions.sizeBytes}), 0)::float8`,
          })
          .from(storeSceneVersions)
          .innerJoin(storeScenes, eq(storeSceneVersions.sceneId, storeScenes.id))
          .where(eq(storeScenes.accountId, accountId)),
        db
          .select({
            bytes: sql<number>`coalesce(sum(octet_length(${storeSceneImages.content})), 0)::float8`,
          })
          .from(storeSceneImages)
          .innerJoin(storeScenes, eq(storeSceneImages.sceneId, storeScenes.id))
          .where(eq(storeScenes.accountId, accountId)),
      ]);
    isSuperadmin = row?.isSuperadmin ?? false;
    installCount = installs[0]?.count ?? 0;
    sceneCount = scenes[0]?.count ?? 0;
    backupCount = backups[0]?.count ?? 0;
    backupBytes = backups[0]?.bytes ?? 0;
    sceneBytes =
      (sceneVersionSizes[0]?.bytes ?? 0) +
      (sceneImageSizes[0]?.bytes ?? 0) +
      (scenes[0]?.previewBytes ?? 0);
  }

  const storageBytes = backupBytes + sceneBytes;

  return (
    <AppShell isSuperadmin={isSuperadmin} title="FrameOS Account">
      {session.accountId ? (
        <UserIdentifier
          email={session.email}
          name={session.name}
          userId={session.accountId}
        />
      ) : null}
      <div className="content-header">
        <div>
          <h1>{session?.name ?? "FrameOS Cloud account"}</h1>
          <p className="copy">{session?.email}</p>
          {session?.accountId ? (
            <p className="copy">
              Storage used: {formatBytes(storageBytes)}
              {storageBytes > 0
                ? ` — backups ${formatBytes(backupBytes)} · store scenes ${formatBytes(sceneBytes)}`
                : ""}
              . Per-account quotas are coming; today only per-item limits
              apply.
            </p>
          ) : null}
        </div>
      </div>
      <AccountNav
        counts={{
          backups: backupCount,
          installs: installCount,
          scenes: sceneCount,
        }}
        hrefs={{
          activity: getAccountUrl("/account/activity"),
          backups: getAccountUrl("/account/backups"),
          installs: getAccountUrl("/account/installs"),
          scenes: getAccountUrl("/account/scenes"),
          security: getAccountUrl("/account/security"),
        }}
      />
      {children}
    </AppShell>
  );
}

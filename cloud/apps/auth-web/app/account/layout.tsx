import { and, eq, isNull, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  accounts,
  clientBackups,
  createDb,
  linkedClients,
  storeScenes,
} from "@frameos-cloud/db";
import { AccountNav } from "../../src/components/AccountNav";
import { AppShell } from "../../src/components/AppShell";
import { UserIdentifier } from "../../src/components/UserIdentifier";
import { getAccountUrl, getCloudBaseUrl } from "../../src/lib/env";
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

  if (session.accountId) {
    const accountId = session.accountId;
    const db = createDb();
    const [[row], installs, scenes, backups] = await Promise.all([
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
        .select({ count: sql<number>`count(*)::int` })
        .from(storeScenes)
        .where(eq(storeScenes.accountId, accountId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(clientBackups)
        .where(eq(clientBackups.accountId, accountId)),
    ]);
    isSuperadmin = row?.isSuperadmin ?? false;
    installCount = installs[0]?.count ?? 0;
    sceneCount = scenes[0]?.count ?? 0;
    backupCount = backups[0]?.count ?? 0;
  }

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
        }}
      />
      {children}
    </AppShell>
  );
}

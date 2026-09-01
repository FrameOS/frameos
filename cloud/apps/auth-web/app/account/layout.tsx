import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  accounts,
  clientBackups,
  createDb,
  frames,
  linkedClients,
} from "@frameos-cloud/db";
import { AccountNav } from "../../src/components/AccountNav";
import { AppShell } from "../../src/components/AppShell";
import { StorageUsageMeters } from "../../src/components/StorageUsageMeters";
import { UserIdentifier } from "../../src/components/UserIdentifier";
import { getAccountUrl, getCloudBaseUrl } from "../../src/lib/env";
import { readSession } from "../../src/lib/session";
import { accountUsage, type AccountUsage } from "../../src/lib/usage";

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
  let backupCount = 0;
  let usage: AccountUsage | null = null;

  if (session.accountId) {
    const accountId = session.accountId;
    const db = createDb();
    // Byte sums come from the same accountUsage() helper the quota
    // enforcement and /api/backends/grants use — one definition of "used".
    const [[row], installs, backups, usageSnapshot] =
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
              // Same predicate as the installs page: cloud-managed frames
              // carry a linkedClients row, but they are counted on the
              // Frames tab, not here.
              notExists(
                db
                  .select({ id: frames.id })
                  .from(frames)
                  .where(eq(frames.linkedClientId, linkedClients.id)),
              ),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(clientBackups)
          .where(eq(clientBackups.accountId, accountId)),
        accountUsage(db, accountId),
      ]);
    isSuperadmin = row?.isSuperadmin ?? false;
    installCount = installs[0]?.count ?? 0;
    backupCount = backups[0]?.count ?? 0;
    usage = usageSnapshot;
  }

  return (
    // noCapture: every /account page is the signed-in user's own data — their
    // name and email in the header here, and frame names, scene names and
    // images, install hostnames, backup names and activity in the subpages.
    <AppShell isSuperadmin={isSuperadmin} noCapture>
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
        {session?.accountId && usage ? <StorageUsageMeters usage={usage} /> : null}
      </div>
      <AccountNav
        counts={{
          backups: backupCount,
          installs: installCount,
        }}
        hrefs={{
          activity: getAccountUrl("/account/activity"),
          backups: getAccountUrl("/account/backups"),
          developer: getAccountUrl("/account/developer"),
          installs: getAccountUrl("/account/installs"),
          security: getAccountUrl("/account/security"),
          settings: getAccountUrl("/account/settings"),
        }}
      />
      {children}
    </AppShell>
  );
}

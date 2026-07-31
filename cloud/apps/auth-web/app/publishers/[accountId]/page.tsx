import { and, desc, eq, gt, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { PublicShell } from "../../../src/components/PublicShell";
import {
  SceneCard,
  type SceneCardScene,
} from "../../../src/components/SceneCard";
import { hasDatabaseUrl } from "../../../src/lib/env";
import { formatDate } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";
import { accountIsSuperadmin } from "../../../src/lib/superadmin";

export const dynamic = "force-dynamic";

// The tab title is the publisher's name — only when they have a public scene,
// mirroring the page's own existence rule (account ids must not be probable).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(accountId) || !hasDatabaseUrl()) {
    return {};
  }
  const db = createDb();
  const [publisher] = await db
    .select({ displayName: accounts.displayName })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(
      and(
        eq(storeScenes.accountId, accountId),
        eq(storeScenes.visibility, "public"),
        eq(storeScenes.status, "active"),
        gt(storeScenes.latestVersion, 0),
      ),
    )
    .limit(1);
  return publisher ? { title: publisher.displayName ?? "FrameOS user" } : {};
}

// Publisher page (STORE-TODO Phase 3): "more from this publisher". Publishers
// are identified by their opaque account id — the web-first/no-usernames
// decision; a page only exists while the account has at least one public
// scene, so account ids cannot be probed for existence.
export default async function PublisherPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(accountId) || !hasDatabaseUrl()) {
    notFound();
  }

  const session = await readSession();
  const db = createDb();

  const scenes: SceneCardScene[] = await db
    .select({
      description: storeScenes.description,
      downloadCount: storeScenes.downloadCount,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sql<boolean>`${storeScenes.previewImage} is not null`,
      id: storeScenes.id,
      name: storeScenes.name,
      publisher: accounts.displayName,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      tags: storeScenes.tags,
      updatedAt: storeScenes.updatedAt,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(
      and(
        eq(storeScenes.accountId, accountId),
        eq(storeScenes.visibility, "public"),
        eq(storeScenes.status, "active"),
        gt(storeScenes.latestVersion, 0),
      ),
    )
    .orderBy(desc(storeScenes.downloadCount), desc(storeScenes.updatedAt))
    .limit(200);

  if (scenes.length === 0) {
    notFound();
  }

  const [publisher] = await db
    .select({
      createdAt: accounts.createdAt,
      displayName: accounts.displayName,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  const totalDownloads = scenes.reduce(
    (sum, scene) => sum + scene.downloadCount,
    0,
  );

  return (
    <PublicShell
      isSuperadmin={await accountIsSuperadmin(session?.accountId)}
      signedIn={Boolean(session)}
      title="FrameOS Scenes"
    >
      <div className="content-header">
        <div>
          <h1>{publisher?.displayName ?? "FrameOS user"}</h1>
          <p className="copy">
            {scenes.length} public scene{scenes.length === 1 ? "" : "s"} ·{" "}
            {totalDownloads} download{totalDownloads === 1 ? "" : "s"}
            {publisher
              ? ` · publishing since ${formatDate(publisher.createdAt)}`
              : null}
          </p>
        </div>
      </div>

      <section className="section-block">
        <div className="grid scene-grid">
          {scenes.map((scene) => (
            <SceneCard key={scene.id} scene={scene} />
          ))}
        </div>
      </section>
    </PublicShell>
  );
}

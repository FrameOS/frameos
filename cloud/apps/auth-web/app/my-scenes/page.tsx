import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createDb, storeScenes } from "@frameos-cloud/db";
import { PublicShell } from "../../src/components/PublicShell";
import { StoreSceneActions } from "../../src/components/StoreSceneActions";
import { StoreTabs } from "../../src/components/StoreTabs";
import { SceneZipUpload } from "../../src/components/SceneZipUpload";
import {
  getCloudBaseUrl,
  getMyScenesUrl,
  getStoreUrl,
} from "../../src/lib/env";
import { formatDate } from "../../src/lib/format";
import { readSession } from "../../src/lib/session";
import { accountIsSuperadmin } from "../../src/lib/superadmin";

export const metadata = { title: "My private scenes" };

export const dynamic = "force-dynamic";

// The "My private scenes" tab of the scene store: every scene the signed-in
// account published (private or public), with filters, zip upload, and the
// visibility/delete actions. This used to be the /account/scenes page (alias
// /scenes on the cloud host); both now redirect here.
export default async function MyScenesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; visibility?: string }>;
}) {
  const session = await readSession();
  const myScenesUrl = getMyScenesUrl();
  if (!session) {
    const loginUrl = new URL("/login", getCloudBaseUrl());
    loginUrl.searchParams.set("return_to", myScenesUrl);
    redirect(loginUrl.toString());
  }
  const isSuperadmin = await accountIsSuperadmin(session.accountId);
  const storeUrl = getStoreUrl();
  const accountId = session.accountId;
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 100) ?? "";
  const visibility = ["private", "public"].includes(params.visibility ?? "")
    ? params.visibility
    : "";
  const status = ["active", "featured", "pulled"].includes(params.status ?? "")
    ? params.status
    : "";

  const conditions: SQL[] = accountId
    ? [eq(storeScenes.accountId, accountId)]
    : [];
  if (query) {
    const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    const match = or(
      ilike(storeScenes.name, pattern),
      ilike(storeScenes.slug, pattern),
      sql`array_to_string(${storeScenes.tags}, ' ') ilike ${pattern}`,
    );
    if (match) {
      conditions.push(match);
    }
  }
  if (visibility) {
    conditions.push(eq(storeScenes.visibility, visibility));
  }
  if (status === "pulled") {
    conditions.push(eq(storeScenes.status, "pulled"));
  } else if (status === "featured") {
    conditions.push(sql`${storeScenes.featuredAt} is not null`);
  } else if (status === "active") {
    conditions.push(eq(storeScenes.status, "active"));
  }

  const sceneRows = accountId
    ? await createDb()
        .select({
          downloadCount: storeScenes.downloadCount,
          hasPreview: sql<boolean>`(${storeScenes.previewImage} is not null or ${storeScenes.previewObjectKey} is not null)`,
          featuredAt: storeScenes.featuredAt,
          id: storeScenes.id,
          latestVersion: storeScenes.latestVersion,
          name: storeScenes.name,
          slug: storeScenes.slug,
          status: storeScenes.status,
          tags: storeScenes.tags,
          updatedAt: storeScenes.updatedAt,
          visibility: storeScenes.visibility,
        })
        .from(storeScenes)
        .where(and(...conditions))
        .orderBy(desc(storeScenes.updatedAt))
    : [];

  return (
    <PublicShell isSuperadmin={isSuperadmin} noCapture signedIn>
      <StoreTabs active="mine" />
      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>My private scenes</h2>
            <p className="copy">
              Scenes you saved to the FrameOS cloud. Private scenes are visible
              only to you and people with a sharing link; public scenes appear
              in the <Link href={storeUrl}>store</Link> and in the in-app store
              repository for everyone.
            </p>
          </div>
        </div>
        {accountId ? <SceneZipUpload /> : null}
        <form action={myScenesUrl} className="filter-bar" method="get">
          <input
            aria-label="Search scenes"
            className="input filter-bar__search"
            defaultValue={query}
            name="q"
            placeholder="Search name, slug, or tags…"
            type="search"
          />
          <select
            aria-label="Visibility"
            className="input filter-bar__select"
            defaultValue={visibility}
            name="visibility"
          >
            <option value="">All visibilities</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
          <select
            aria-label="Status"
            className="input filter-bar__select"
            defaultValue={status}
            name="status"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="featured">Featured</option>
            <option value="pulled">Pulled</option>
          </select>
          <button className="button button--small" type="submit">
            Filter
          </button>
          {query || visibility || status ? (
            <Link
              className="button button--small button--subtle"
              href={myScenesUrl}
            >
              Clear
            </Link>
          ) : null}
        </form>
        {sceneRows.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th aria-label="Preview" />
                <th>Name</th>
                <th>Tags</th>
                <th>Visibility</th>
                <th>Status</th>
                <th>Version</th>
                <th>Downloads</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sceneRows.map((scene) => (
                <tr key={scene.id}>
                  <td className="table-thumb-cell">
                    <Link href={`/s/${scene.slug}`} tabIndex={-1}>
                      {scene.hasPreview ? (
                        <img
                          alt=""
                          className="table-thumb"
                          loading="lazy"
                          src={`/api/store/scenes/${scene.id}/image`}
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="table-thumb table-thumb--empty"
                        />
                      )}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/s/${scene.slug}`}>{scene.name}</Link>
                  </td>
                  <td>
                    {scene.tags.length > 0 ? (
                      <div className="tag-list">
                        {scene.tags.map((tag) => (
                          <span className="tag-pill" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        scene.visibility === "public" ? "pill pill-ok" : "pill"
                      }
                    >
                      {scene.visibility === "public" ? "Public" : "Private"}
                    </span>
                  </td>
                  <td>
                    {scene.status === "pulled" ? (
                      <span className="pill pill-warning">Pulled</span>
                    ) : scene.featuredAt ? (
                      <span className="pill pill-ok">Featured</span>
                    ) : (
                      <span className="pill">Active</span>
                    )}
                  </td>
                  <td>v{scene.latestVersion}</td>
                  <td>{scene.downloadCount}</td>
                  <td>{formatDate(scene.updatedAt)}</td>
                  <td>
                    <StoreSceneActions
                      name={scene.name}
                      sceneId={scene.id}
                      status={scene.status}
                      visibility={scene.visibility}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : query || visibility || status ? (
          <section className="card">
            <p>No scenes match these filters.</p>
          </section>
        ) : (
          <section className="card">
            <p>
              Nothing published yet. In FrameOS, open a frame&apos;s Templates
              panel and choose “Save to cloud drive” on one of your scenes
              (requires the store publishing feature on your cloud link).
            </p>
          </section>
        )}
      </section>
    </PublicShell>
  );
}

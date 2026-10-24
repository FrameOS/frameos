import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import { AdminPublisherBanButton } from "../../../src/components/AdminPublisherBanButton";
import { AdminPublisherVerifyButton } from "../../../src/components/AdminPublisherVerifyButton";
import { AdminRecategorizeButton } from "../../../src/components/AdminRecategorizeButton";
import { AdminSceneActions } from "../../../src/components/AdminSceneActions";
import { AdminSceneCategorySelect } from "../../../src/components/AdminSceneCategorySelect";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { SortableTable } from "../../../src/components/SortableTable";
import { listScenesForAdmin } from "../../../src/lib/admin";
import { requireSuperadmin, searchQueryOf } from "../../../src/lib/admin-page";
import { formatDate } from "../../../src/lib/format";

export const metadata = { title: "Store scenes" };

type AdminScenesPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminScenesPage({
  searchParams,
}: AdminScenesPageProps) {
  await requireSuperadmin("/admin/scenes");

  const query = searchQueryOf(searchParams ? await searchParams : {});

  const scenes = await listScenesForAdmin(createDb(), query);

  return (
    // noCapture: the moderation table joins every scene to its owner's email.
    <AppShell isSuperadmin noCapture title="Store scenes">
      <div className="content-header">
        <div>
          <p className="copy">
            Everything in the store, including private scenes. Pull is the
            kill switch: the scene disappears everywhere and downloads answer
            410 until it is restored.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        <form action="/admin/scenes" className="inline-actions" method="get">
          <input
            className="input"
            defaultValue={query ?? ""}
            name="q"
            placeholder="Search by name, slug, or owner email"
            type="search"
          />
          <button className="button" type="submit">
            Search
          </button>
        </form>

        <AdminRecategorizeButton />

        {scenes.length === 0 ? (
          <section className="card">
            <p>No matching scenes.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "scene", label: "Scene" },
              { key: "owner", label: "Owner" },
              { key: "category", label: "Category" },
              { key: "visibility", label: "Visibility" },
              { key: "status", label: "Status" },
              { key: "downloads", label: "Downloads" },
              { key: "updated", label: "Updated" },
              { key: "actions", label: "Actions", sortable: false },
            ]}
            rows={scenes.map((scene) => ({
              cells: [
                <>
                  <div>
                    <Link href={`/s/${scene.slug}`}>{scene.name}</Link>
                    {scene.riskFlags.includes("shell") ? (
                      <span
                        className="risk-badge"
                        title="Configures apps or code that run shell commands"
                      >
                        shell
                      </span>
                    ) : null}
                    {scene.openReports > 0 ? (
                      <span className="risk-badge">
                        {scene.openReports} open report
                        {scene.openReports === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <div className="copy">
                    {scene.slug} · v{scene.latestVersion}
                  </div>
                </>,
                <>
                  <div>
                    {scene.ownerName ?? "—"}
                    {scene.ownerVerifiedAt ? (
                      <span className="pill pill-ok">verified</span>
                    ) : null}
                    {scene.ownerBannedAt ? (
                      <span className="risk-badge">banned</span>
                    ) : null}
                  </div>
                  <div className="copy">{scene.ownerEmail ?? "no email"}</div>
                </>,
                <AdminSceneCategorySelect
                  category={scene.category}
                  sceneId={scene.id}
                />,
                <span
                  className={
                    scene.visibility === "public" ? "pill pill-ok" : "pill"
                  }
                >
                  {scene.visibility}
                </span>,
                scene.status === "pulled" ? (
                  <span
                    className="pill pill-warning"
                    title={scene.pulledReason ?? undefined}
                  >
                    Pulled
                  </span>
                ) : scene.featuredAt ? (
                  <span className="pill pill-ok">Featured</span>
                ) : (
                  <span className="pill">Active</span>
                ),
                scene.downloadCount,
                formatDate(scene.updatedAt),
                <div className="inline-actions">
                  <AdminSceneActions
                    featured={scene.featuredAt !== null}
                    name={scene.name}
                    sceneId={scene.id}
                    status={scene.status}
                  />
                  <AdminPublisherVerifyButton
                    accountId={scene.ownerId}
                    ownerLabel={
                      scene.ownerName ?? scene.ownerEmail ?? "this account"
                    }
                    verified={scene.ownerVerifiedAt !== null}
                  />
                  <AdminPublisherBanButton
                    accountId={scene.ownerId}
                    banned={scene.ownerBannedAt !== null}
                    ownerLabel={
                      scene.ownerName ?? scene.ownerEmail ?? "this account"
                    }
                  />
                </div>,
              ],
              key: scene.id,
              sort: [
                scene.name,
                scene.ownerEmail ?? scene.ownerName,
                scene.category,
                scene.visibility,
                // Featured, then active, then pulled.
                scene.status === "pulled" ? 2 : scene.featuredAt ? 0 : 1,
                scene.downloadCount,
                scene.updatedAt.getTime(),
                null,
              ],
            }))}
          />
        )}
      </section>
    </AppShell>
  );
}

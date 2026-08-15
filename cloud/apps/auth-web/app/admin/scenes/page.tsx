import Link from "next/link";
import { redirect } from "next/navigation";
import { createDb } from "@frameos-cloud/db";
import { AdminPublisherBanButton } from "../../../src/components/AdminPublisherBanButton";
import { AdminPublisherVerifyButton } from "../../../src/components/AdminPublisherVerifyButton";
import { AdminRecategorizeButton } from "../../../src/components/AdminRecategorizeButton";
import { AdminSceneActions } from "../../../src/components/AdminSceneActions";
import { AdminSceneCategorySelect } from "../../../src/components/AdminSceneCategorySelect";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import {
  getSuperadminContext,
  listScenesForAdmin,
} from "../../../src/lib/admin";
import { formatDate } from "../../../src/lib/format";

export const metadata = { title: "Store scenes" };

type AdminScenesPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminScenesPage({
  searchParams,
}: AdminScenesPageProps) {
  const context = await getSuperadminContext();
  if (context.kind === "unauthenticated") {
    redirect("/login?return_to=/admin/scenes");
  }
  if (context.kind === "forbidden") {
    redirect("/account");
  }

  const params = searchParams ? await searchParams : {};
  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = rawQuery?.trim() || undefined;

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
          <table className="table">
            <thead>
              <tr>
                <th>Scene</th>
                <th>Owner</th>
                <th>Category</th>
                <th>Visibility</th>
                <th>Status</th>
                <th>Downloads</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {scenes.map((scene) => (
                <tr key={scene.id}>
                  <td>
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
                  </td>
                  <td>
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
                  </td>
                  <td>
                    <AdminSceneCategorySelect
                      category={scene.category}
                      sceneId={scene.id}
                    />
                  </td>
                  <td>
                    <span
                      className={
                        scene.visibility === "public" ? "pill pill-ok" : "pill"
                      }
                    >
                      {scene.visibility}
                    </span>
                  </td>
                  <td>
                    {scene.status === "pulled" ? (
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
                    )}
                  </td>
                  <td>{scene.downloadCount}</td>
                  <td>{formatDate(scene.updatedAt)}</td>
                  <td>
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

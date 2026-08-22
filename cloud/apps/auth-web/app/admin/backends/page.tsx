import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { listBackendsForAdmin } from "../../../src/lib/admin";
import { requireSuperadmin, searchQueryOf } from "../../../src/lib/admin-page";
import { formatDate, formatDateTime } from "../../../src/lib/format";

export const metadata = { title: "Backends" };

type AdminBackendsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminBackendsPage({
  searchParams,
}: AdminBackendsPageProps) {
  await requireSuperadmin("/admin/backends");
  const query = searchQueryOf(searchParams ? await searchParams : {});
  const backends = await listBackendsForAdmin(createDb(), query);
  const active = backends.filter((backend) => backend.revokedAt === null);

  return (
    // noCapture: owner emails and install hostnames.
    <AppShell isSuperadmin noCapture title="Backends">
      <div className="content-header">
        <div>
          <p className="copy">
            Every self-hosted FrameOS backend linked to an account, most
            recently seen first. A revoked link stays listed until its owner
            removes it. Tokens are never shown.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        <form action="/admin/backends" className="inline-actions" method="get">
          <input
            className="input"
            defaultValue={query ?? ""}
            name="q"
            placeholder="Search by name, origin, or owner"
            type="search"
          />
          <button className="button" type="submit">
            Search
          </button>
          <span className="copy">
            {active.length}/{backends.length} active
            {backends.length === 200 ? " (first 200)" : ""}
          </span>
        </form>

        {backends.length === 0 ? (
          <section className="card">
            <p>No matching backends.</p>
          </section>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Last seen</th>
                  <th>Last sync</th>
                  <th>Linked</th>
                </tr>
              </thead>
              <tbody>
                {backends.map((backend) => (
                  <tr
                    className={backend.revokedAt ? "row-muted" : undefined}
                    key={backend.id}
                  >
                    <td>
                      <div>{backend.name}</div>
                      <div className="copy">{backend.localOrigin ?? "—"}</div>
                    </td>
                    <td>
                      <div>{backend.ownerName ?? "—"}</div>
                      <div className="copy">
                        <Link
                          href={`/admin/users?q=${encodeURIComponent(backend.ownerEmail ?? "")}`}
                        >
                          {backend.ownerEmail ?? "no email"}
                        </Link>
                      </div>
                    </td>
                    <td>
                      {backend.revokedAt ? (
                        <span
                          className="pill pill-warning"
                          title={`Revoked ${formatDateTime(backend.revokedAt)}`}
                        >
                          Revoked
                        </span>
                      ) : (
                        <span className="pill pill-ok">Active</span>
                      )}
                    </td>
                    <td className="cell-nowrap">
                      {backend.reportedFrameosVersion ?? "—"}
                    </td>
                    <td className="cell-nowrap">
                      {backend.lastSeenAt
                        ? formatDateTime(backend.lastSeenAt)
                        : "never"}
                    </td>
                    <td className="cell-nowrap">
                      {backend.lastSyncAt
                        ? formatDateTime(backend.lastSyncAt)
                        : "never"}
                    </td>
                    <td className="cell-nowrap">
                      {formatDate(backend.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}

import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { ResolveReportButton } from "../../../src/components/ResolveReportButton";
import { SortableTable } from "../../../src/components/SortableTable";
import { listOpenReportsForAdmin } from "../../../src/lib/admin";
import { requireSuperadmin } from "../../../src/lib/admin-page";
import { formatDateTime } from "../../../src/lib/format";

export const metadata = { title: "Scene reports" };

export default async function AdminReportsPage() {
  await requireSuperadmin("/admin/reports");

  const reports = await listOpenReportsForAdmin(createDb());

  return (
    // noCapture: reports carry the reporter's email and the reported
    // scene's name.
    <AppShell isSuperadmin noCapture title="Scene reports">
      <div className="content-header">
        <div>
          <p className="copy">
            Open reports from signed-in users, oldest first. Resolving only
            closes the report — pull the scene or ban the publisher from the
            scenes list if action is needed.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        {reports.length === 0 ? (
          <section className="card">
            <p>No open reports. Nothing needs your attention.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "reported", label: "Reported" },
              { key: "scene", label: "Scene" },
              { key: "reason", label: "Reason" },
              { key: "reporter", label: "Reporter" },
              { key: "actions", label: "Actions", sortable: false },
            ]}
            rows={reports.map((report) => ({
              cells: [
                formatDateTime(report.createdAt),
                <>
                  {report.sceneSlug ? (
                    <Link href={`/s/${report.sceneSlug}`}>
                      {report.sceneName ?? report.sceneSlug}
                    </Link>
                  ) : (
                    (report.sceneName ?? "deleted scene")
                  )}
                  {report.sceneStatus === "pulled" ? (
                    <span className="risk-badge">pulled</span>
                  ) : null}
                </>,
                <span className="copy">{report.reason}</span>,
                <span className="copy">{report.reporterEmail ?? "—"}</span>,
                <div className="inline-actions">
                  <ResolveReportButton reportId={report.id} />
                  {report.sceneSlug ? (
                    <Link
                      className="button"
                      href={`/admin/scenes?q=${encodeURIComponent(report.sceneSlug)}`}
                    >
                      Moderate
                    </Link>
                  ) : null}
                </div>,
              ],
              key: report.id,
              sort: [
                report.createdAt.getTime(),
                report.sceneName ?? report.sceneSlug,
                report.reason,
                report.reporterEmail,
                null,
              ],
            }))}
          />
        )}
      </section>
    </AppShell>
  );
}

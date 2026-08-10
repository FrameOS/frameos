import Link from "next/link";
import { redirect } from "next/navigation";
import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { ResolveReportButton } from "../../../src/components/ResolveReportButton";
import {
  getSuperadminContext,
  listOpenReportsForAdmin,
} from "../../../src/lib/admin";
import { formatDateTime } from "../../../src/lib/format";

export const metadata = { title: "Scene reports" };

export default async function AdminReportsPage() {
  const context = await getSuperadminContext();
  if (context.kind === "unauthenticated") {
    redirect("/login?return_to=/admin/reports");
  }
  if (context.kind === "forbidden") {
    redirect("/account");
  }

  const reports = await listOpenReportsForAdmin(createDb());

  return (
    <AppShell isSuperadmin title="Scene reports">
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
          <table className="table">
            <thead>
              <tr>
                <th>Reported</th>
                <th>Scene</th>
                <th>Reason</th>
                <th>Reporter</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td>{formatDateTime(report.createdAt)}</td>
                  <td>
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
                  </td>
                  <td className="copy">{report.reason}</td>
                  <td className="copy">{report.reporterEmail ?? "—"}</td>
                  <td>
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

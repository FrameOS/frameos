import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../src/components/AdminNav";
import { AppShell } from "../../src/components/AppShell";
import { getAdminOverview } from "../../src/lib/admin";
import { requireSuperadmin } from "../../src/lib/admin-page";
import { formatBytes } from "../../src/lib/format";
import { runLiveChecks, runSystemChecks } from "../../src/lib/system-checks";

export const metadata = { title: "Admin" };

function StatTile({
  detail,
  href,
  label,
  total,
  value,
}: {
  detail?: string;
  href: string;
  label: string;
  // When given, the tile reads "value / total".
  total?: number;
  value: number;
}) {
  return (
    <Link className="stat-tile" href={href}>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">
        {value}
        {total !== undefined ? <small>/{total}</small> : null}
      </span>
      {detail ? <span className="stat-tile__detail">{detail}</span> : null}
    </Link>
  );
}

export default async function AdminPage() {
  await requireSuperadmin("/admin");

  const db = createDb();
  const [overview, liveChecks] = await Promise.all([
    getAdminOverview(db),
    runLiveChecks(),
  ]);

  return (
    // noCapture: the admin surfaces never report analytics (see
    // analytics-redaction.ts); the marker is belt and braces.
    <AppShell isSuperadmin noCapture title="Admin">
      <div className="content-header">
        <div>
          <p className="copy">
            Everything on this instance at a glance. Counts read
            &quot;active / total&quot;: a backend is active until its link is
            revoked, a frame once its enrollment is confirmed, a scene when it
            is public and not pulled.
          </p>
        </div>
      </div>

      <AdminNav counts={{ reports: overview.openReports }} />

      <section className="section-block">
        <div className="stat-grid">
          <StatTile
            detail={`${overview.accounts.last7d} new in 7 days · ${overview.accounts.superadmins} superadmin${overview.accounts.superadmins === 1 ? "" : "s"}`}
            href="/admin/users"
            label="Users"
            value={overview.accounts.total}
          />
          <StatTile
            detail={`${overview.backends.seen24h} seen in 24 h`}
            href="/admin/backends"
            label="Backends"
            total={overview.backends.total}
            value={overview.backends.active}
          />
          <StatTile
            detail={`${overview.frames.connected} online now · ${overview.frames.pending} pending`}
            href="/admin/frames"
            label="Frames"
            total={overview.frames.total}
            value={overview.frames.active}
          />
          <StatTile
            detail={`${overview.storeScenes.pulled} pulled`}
            href="/admin/scenes"
            label="Store scenes"
            total={overview.storeScenes.total}
            value={overview.storeScenes.public}
          />
          <StatTile
            detail={overview.openReports === 0 ? "queue is empty" : "awaiting review"}
            href="/admin/reports"
            label="Open reports"
            value={overview.openReports}
          />
          <StatTile
            detail={formatBytes(overview.backups.bytes)}
            href="/admin/users"
            label="Backups"
            value={overview.backups.count}
          />
          <StatTile
            detail="signed-in, unexpired"
            href="/admin/users"
            label="Sessions"
            value={overview.sessions}
          />
        </div>
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>Live checks</h2>
            <p className="copy">
              Probed on every load of this page. A set environment variable is
              not proof the service behind it works — these are.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {liveChecks.map((check) => (
                <tr key={check.name}>
                  <td className="cell-nowrap">{check.name}</td>
                  <td>
                    <span
                      className={
                        check.state === "ok"
                          ? "pill pill-ok"
                          : check.state === "not_configured"
                            ? "pill"
                            : "pill pill-warning"
                      }
                    >
                      {check.state === "ok"
                        ? "OK"
                        : check.state === "not_configured"
                          ? "Not set"
                          : check.state === "warning"
                            ? "Degraded"
                            : "Failing"}
                    </span>
                  </td>
                  <td className="copy">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>System checks</h2>
            <p className="copy">
              Configuration this instance runs with. Only presence is shown,
              never values.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Status</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {runSystemChecks().map((check) => (
                <tr key={check.name}>
                  <td className="cell-nowrap">
                    <code>{check.name}</code>
                  </td>
                  <td>
                    <span
                      className={
                        check.configured
                          ? "pill pill-ok"
                          : check.required
                            ? "pill pill-warning"
                            : "pill"
                      }
                    >
                      {check.configured
                        ? "Configured"
                        : check.required
                          ? "Missing"
                          : "Not set"}
                    </span>
                  </td>
                  <td className="copy">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

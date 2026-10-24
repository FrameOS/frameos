import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import { aiUsageSummary } from "@frameos-cloud/ledger";
import { AdminNav } from "../../src/components/AdminNav";
import { AppShell } from "../../src/components/AppShell";
import { SortableTable } from "../../src/components/SortableTable";
import { getAdminOverview } from "../../src/lib/admin";
import { requireSuperadmin } from "../../src/lib/admin-page";
import { sumAiUsage } from "../../src/lib/billing-admin";
import { formatBytes, formatDateTime, formatMicrosUsd } from "../../src/lib/format";
import { storageSnapshotSummary } from "../../src/lib/storage-usage";
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
  // A count, or an already-formatted figure (bytes) that has no total.
  value: number | string;
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
  const now = new Date();
  const hours = (count: number) => new Date(now.getTime() - count * 60 * 60 * 1000);
  // AI spend today, this week, this month, and ever: the same report the
  // billing page breaks down by key and surface, summed to one figure per
  // window.
  const aiSpend = (since: Date) => aiUsageSummary(db, { since, until: now }).then(sumAiUsage);
  const [overview, liveChecks, storage, spendDay, spendWeek, spendMonth, spendEver] =
    await Promise.all([
      getAdminOverview(db),
      runLiveChecks(),
      storageSnapshotSummary(db),
      aiSpend(hours(24)),
      aiSpend(hours(7 * 24)),
      aiSpend(hours(30 * 24)),
      aiSpend(new Date(0)),
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
            label="Backend backups"
            value={overview.backups.count}
          />
          <StatTile
            detail={
              overview.backupRuns.lastAt
                ? `last ${formatDateTime(overview.backupRuns.lastAt)}${
                    overview.backupRuns.lastBytes ? ` · ${formatBytes(overview.backupRuns.lastBytes)} dump` : ""
                  } · ${overview.backupRuns.last7d} in 7 days`
                : "no run recorded yet"
            }
            href="/admin/storage"
            label="Nightly backups"
            value={overview.backupRuns.count}
          />
          <StatTile
            detail={
              storage.computedAt
                ? `measured ${formatDateTime(storage.computedAt)}`
                : "not measured yet"
            }
            href="/admin/storage"
            label="Stored"
            value={formatBytes(storage.totalBytes)}
          />
          <StatTile
            detail="signed-in, unexpired"
            href="/admin/users"
            label="Sessions"
            value={overview.sessions}
          />
          <StatTile
            detail={`${overview.photos.files} photo${overview.photos.files === 1 ? "" : "s"} in ${overview.photos.albums} album${overview.photos.albums === 1 ? "" : "s"} · ${overview.photos.accounts} account${overview.photos.accounts === 1 ? "" : "s"} · ${overview.photos.shares} share link${overview.photos.shares === 1 ? "" : "s"}`}
            href="/admin/storage"
            label="Photos"
            value={formatBytes(overview.photos.bytes)}
          />
        </div>
      </section>

      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>AI spend</h2>
            <p className="copy">
              What the provider charged us for metered AI turns, from the
              usage records. A turn on a customer&apos;s own key is counted
              but costs us nothing; the list figure prices every turn as if
              we had paid.
            </p>
          </div>
        </div>
        <div className="stat-grid">
          {[
            { label: "Last 24 hours", totals: spendDay },
            { label: "Last 7 days", totals: spendWeek },
            { label: "Last 30 days", totals: spendMonth },
            { label: "All time", totals: spendEver },
          ].map(({ label, totals }) => (
            <StatTile
              detail={`${totals.turns} turn${totals.turns === 1n ? "" : "s"} · ${formatMicrosUsd(totals.listCostMicros)} at list · ${formatMicrosUsd(totals.priceMicros)} priced to customers`}
              href="/admin/billing"
              key={label}
              label={label}
              value={formatMicrosUsd(totals.costMicros)}
            />
          ))}
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
        <SortableTable
          columns={[
            { key: "service", label: "Service" },
            { key: "status", label: "Status" },
            { key: "detail", label: "Detail" },
          ]}
          rows={liveChecks.map((check) => ({
            cells: [
              <span className="cell-nowrap">{check.name}</span>,
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
              </span>,
              <span className="copy">{check.detail}</span>,
            ],
            key: check.name,
            sort: [
              check.name,
              // Failing first: the row that needs a look.
              check.state === "ok" ? 3 : check.state === "not_configured" ? 2 : check.state === "warning" ? 1 : 0,
              check.detail,
            ],
          }))}
        />
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
        <SortableTable
          columns={[
            { key: "setting", label: "Setting" },
            { key: "status", label: "Status" },
            { key: "detail", label: "What it does" },
          ]}
          rows={runSystemChecks().map((check) => ({
            cells: [
              <span className="cell-nowrap">
                <code>{check.name}</code>
              </span>,
              <span
                className={
                  check.configured
                    ? "pill pill-ok"
                    : check.required
                      ? "pill pill-warning"
                      : "pill"
                }
              >
                {check.configured ? "Configured" : check.required ? "Missing" : "Not set"}
              </span>,
              <span className="copy">{check.detail}</span>,
            ],
            key: check.name,
            sort: [
              check.name,
              // Missing first, then not set, then configured.
              check.configured ? 2 : check.required ? 0 : 1,
              check.detail,
            ],
          }))}
        />
      </section>
    </AppShell>
  );
}

import { createDb } from "@frameos-cloud/db";
import { after } from "next/server";
import { AdminNav } from "../../../src/components/AdminNav";
import { AdminStorageRefreshButton } from "../../../src/components/AdminStorageRefreshButton";
import { AppShell } from "../../../src/components/AppShell";
import { SortableTable } from "../../../src/components/SortableTable";
import { requireSuperadmin, searchQueryOf } from "../../../src/lib/admin-page";
import { formatBytes, formatDateTime } from "../../../src/lib/format";
import {
  listAccountStorageForAdmin,
  refreshAccountStorageUsageSafely,
  storageRefreshDue,
  storageRefreshInFlight,
  storageSnapshotIsStale,
} from "../../../src/lib/storage-usage";

export const metadata = { title: "Storage" };

type AdminStoragePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function Bytes({ bytes }: { bytes: number }) {
  return bytes > 0 ? (
    <span className="cell-nowrap">{formatBytes(bytes)}</span>
  ) : (
    <span className="ratio--empty">—</span>
  );
}

export default async function AdminStoragePage({
  searchParams,
}: AdminStoragePageProps) {
  await requireSuperadmin("/admin/storage");
  const query = searchQueryOf(searchParams ? await searchParams : {});

  const db = createDb();
  const overview = await listAccountStorageForAdmin(db, query);

  // The snapshot is what makes this page instant; keeping it fresh is the
  // page's job, but never the request's. A stale (or incomplete) snapshot
  // schedules a refresh with after(), which runs once this response has been
  // sent — so the sweep is not racing the render it would slow down, and its
  // numbers land for the next load. Not on every load, though: a sweep that
  // just ran and still left an account unmeasured gets a few minutes before
  // it is retried (storageRefreshDue), or the retry would be the page load.
  // The line below says how old the figures being shown are.
  const stale = storageSnapshotIsStale(overview);
  const due = storageRefreshDue(overview);
  if (due) {
    after(() => refreshAccountStorageUsageSafely(db));
  }
  const refreshing = due || storageRefreshInFlight();

  const { totals } = overview;

  return (
    // noCapture: this table lists every account's email address.
    <AppShell isSuperadmin noCapture title="Storage">
      <div className="content-header">
        <div>
          <p className="copy">
            What each account occupies, biggest first. Measured in the
            background, not on this request — the figures are a snapshot, and
            the age below says which one.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        <div className="stat-grid">
          <div className="stat-tile">
            <span className="stat-tile__label">Total stored</span>
            <span className="stat-tile__value">{formatBytes(totals.totalBytes)}</span>
            <span className="stat-tile__detail">across every account</span>
          </div>
          <div className="stat-tile">
            <span className="stat-tile__label">Scenes</span>
            <span className="stat-tile__value">
              {formatBytes(totals.privateSceneBytes + totals.publicSceneBytes)}
            </span>
            <span className="stat-tile__detail">
              {formatBytes(totals.privateSceneBytes)} private (metered)
            </span>
          </div>
          <div className="stat-tile">
            <span className="stat-tile__label">Backups</span>
            <span className="stat-tile__value">{formatBytes(totals.backupBytes)}</span>
            <span className="stat-tile__detail">
              {totals.backupCount} file{totals.backupCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="stat-tile">
            <span className="stat-tile__label">Telemetry</span>
            <span className="stat-tile__value">
              {formatBytes(totals.frameLogBytes + totals.frameMetricsBytes)}
            </span>
            <span className="stat-tile__detail">logs and metrics</span>
          </div>
          <div className="stat-tile">
            <span className="stat-tile__label">Asset cache</span>
            <span className="stat-tile__value">
              {formatBytes(totals.frameAssetBytes)}
            </span>
            <span className="stat-tile__detail">device files held here</span>
          </div>
          <div className="stat-tile">
            <span className="stat-tile__label">Photos</span>
            <span className="stat-tile__value">{formatBytes(totals.photoBytes)}</span>
            <span className="stat-tile__detail">photo libraries in the object store</span>
          </div>
        </div>
      </section>

      <section className="section-block">
        <div className="filter-bar">
          <form action="/admin/storage" className="filter-bar" method="get">
            <input
              aria-label="Search accounts"
              className="input filter-bar__search"
              defaultValue={query ?? ""}
              name="q"
              placeholder="Search by email or name"
              type="search"
            />
            <button className="button button--small" type="submit">
              Search
            </button>
          </form>
          <AdminStorageRefreshButton running={refreshing} />
        </div>

        <p className="copy">
          {overview.computedAt
            ? `Measured ${formatDateTime(overview.computedAt)}.`
            : "Never measured yet."}{" "}
          {overview.missing > 0
            ? `${overview.missing} account${overview.missing === 1 ? " has" : "s have"} not been measured yet.`
            : null}{" "}
          {refreshing
            ? "A refresh is running in the background — reload in a moment."
            : stale
              ? "The last sweep could not measure everything; it is retried in a few minutes, or now with the button."
              : null}
        </p>

        {overview.rows.length === 0 ? (
          <section className="card">
            <p>No matching users.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "user", label: "User" },
              { key: "total", label: "Total" },
              {
                key: "privateScenes",
                label: "Scenes (private)",
                title: "Counts against the account's scene quota",
              },
              {
                key: "publicScenes",
                label: "Scenes (public)",
                title: "Published scenes are free, but still occupy disk",
              },
              { key: "backups", label: "Backups" },
              { key: "frameLogs", label: "Frame logs" },
              {
                key: "metrics",
                label: "Metrics",
                title: "Retained metrics samples — no quota measures these",
              },
              {
                key: "assetCache",
                label: "Asset cache",
                title: "Cached device files — no quota measures these",
              },
              { key: "photos", label: "Photos", title: "The photo library, against its own quota" },
              { key: "measured", label: "Measured" },
            ]}
            rows={overview.rows.map((row) => ({
              cells: [
                <>
                  <div>{row.displayName ?? "—"}</div>
                  <div className="copy">{row.primaryEmail ?? "no email"}</div>
                </>,
                <strong>
                  <Bytes bytes={row.totalBytes} />
                </strong>,
                <Bytes bytes={row.privateSceneBytes} />,
                <Bytes bytes={row.publicSceneBytes} />,
                <>
                  <Bytes bytes={row.backupBytes} />
                  {row.backupCount > 0 ? (
                    <div className="copy">
                      {row.backupCount} file{row.backupCount === 1 ? "" : "s"}
                    </div>
                  ) : null}
                </>,
                <Bytes bytes={row.frameLogBytes} />,
                <Bytes bytes={row.frameMetricsBytes} />,
                <Bytes bytes={row.frameAssetBytes} />,
                <Bytes bytes={row.photoBytes} />,
                <span className="cell-nowrap copy">
                  {row.computedAt ? formatDateTime(row.computedAt) : "not measured"}
                </span>,
              ],
              className: row.computedAt ? undefined : "row-muted",
              key: row.accountId,
              sort: [
                row.primaryEmail ?? row.displayName,
                row.totalBytes,
                row.privateSceneBytes,
                row.publicSceneBytes,
                row.backupBytes,
                row.frameLogBytes,
                row.frameMetricsBytes,
                row.frameAssetBytes,
                row.photoBytes,
                row.computedAt?.getTime() ?? null,
              ],
            }))}
          />
        )}
      </section>
    </AppShell>
  );
}

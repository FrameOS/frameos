import { asc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { createDb, frameLogs, frames } from "@frameos-cloud/db";
import { AddFramePanel } from "../../../src/components/AddFramePanel";
import { FrameRowActions } from "../../../src/components/FrameRowActions";
import { formatBytes, formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "My frames" };

function hardwareLabel(hardware: unknown) {
  if (!hardware || typeof hardware !== "object") {
    return "—";
  }
  const value = hardware as Record<string, unknown>;
  const platform = typeof value.platform === "string" ? value.platform : "";
  const size =
    typeof value.width === "number" && typeof value.height === "number"
      ? `${value.width}×${value.height}`
      : "";
  return [platform, size].filter(Boolean).join(" · ") || "—";
}

// The fleet table: enrollment state, liveness, per-frame log storage. The
// full management UI (scenes, schedule, settings, live logs) is the shared
// FrameOS workspace served at /frames.
export default async function AccountFramesPage() {
  const session = await readSession();
  const accountId = session?.accountId;
  const db = accountId ? createDb() : null;

  const frameRows =
    db && accountId
      ? await db
          .select({
            assignedChecksum: frames.assignedChecksum,
            connected: frames.connected,
            createdAt: frames.createdAt,
            frameosVersion: frames.frameosVersion,
            hardware: frames.hardware,
            id: frames.id,
            lastSeenAt: frames.lastSeenAt,
            // ${frames.id} would render unqualified here (drizzle strips table
            // names in single-table projections) and resolve to frame_logs.id;
            // ${frames}.id keeps the correlation qualified.
            logBytes: sql<number>`coalesce((select sum(${frameLogs.sizeBytes}) from ${frameLogs} where ${frameLogs.frameId} = ${frames}.id), 0)::float8`,
            name: frames.name,
            scenesChecksum: frames.scenesChecksum,
            status: frames.status,
          })
          .from(frames)
          .where(eq(frames.accountId, accountId))
          .orderBy(asc(frames.createdAt))
      : [];

  const visibleRows = frameRows.filter((frame) => frame.status !== "revoked");

  return (
    <section className="section-block">
      <div className="content-header compact-header">
        <div>
          <h2>My frames</h2>
          <p className="copy">
            Frames enrolled directly with FrameOS Cloud. They run sandboxed
            interpreted scenes only — the cloud can never open a shell, write
            files, or reach your network. Manage scenes and settings in the{" "}
            <Link href="/frames">frames workspace</Link>.
          </p>
        </div>
        <div className="inline-actions">
          <AddFramePanel />
        </div>
      </div>

      {visibleRows.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Hardware</th>
              <th>Version</th>
              <th>Scenes</th>
              <th>Logs stored</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((frame) => (
              <tr key={frame.id}>
                <td>
                  <Link href={`/frames/${frame.id}`}>{frame.name}</Link>
                </td>
                <td>
                  {frame.status === "pending" ? (
                    <span className="pill pill--warning">pending</span>
                  ) : frame.connected ? (
                    <span className="pill pill--success">online</span>
                  ) : (
                    <span className="pill">offline</span>
                  )}
                </td>
                <td>{hardwareLabel(frame.hardware)}</td>
                <td>{frame.frameosVersion ?? "—"}</td>
                <td>
                  {frame.assignedChecksum
                    ? frame.assignedChecksum === frame.scenesChecksum
                      ? "in sync"
                      : "sync pending"
                    : "none assigned"}
                </td>
                <td>{formatBytes(frame.logBytes)}</td>
                <td>
                  {frame.lastSeenAt ? formatDateTime(frame.lastSeenAt) : "never"}
                </td>
                <td>
                  <FrameRowActions frameId={frame.id} status={frame.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="copy">
          No frames yet. Click “Add frame” to enroll your first one — a
          one-line install script for any Raspberry Pi (or most Linux boxes),
          an SD card image for the Pi Zero 2 W / W, or an ESP32 flashed from
          this browser.
        </p>
      )}
    </section>
  );
}

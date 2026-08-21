import Link from "next/link";
import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { listFramesForAdmin } from "../../../src/lib/admin";
import { requireSuperadmin, searchQueryOf } from "../../../src/lib/admin-page";
import { formatDate, formatDateTime } from "../../../src/lib/format";

export const metadata = { title: "Frames" };

type AdminFramesPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// "platform · board · device · WxH" from the frame's self-reported hardware
// object (shape: docs/cloud-frames.md, the enrollment request).
function hardwareLabel(hardware: unknown): string {
  if (!hardware || typeof hardware !== "object") {
    return "—";
  }
  const record = hardware as Record<string, unknown>;
  const parts = [record.platform, record.board, record.device]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .filter((value, index, all) => all.indexOf(value) === index);
  if (typeof record.width === "number" && typeof record.height === "number" && record.width > 0) {
    parts.push(`${record.width}×${record.height}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export default async function AdminFramesPage({
  searchParams,
}: AdminFramesPageProps) {
  await requireSuperadmin("/admin/frames");
  const query = searchQueryOf(searchParams ? await searchParams : {});
  const frames = await listFramesForAdmin(createDb(), query);
  const active = frames.filter((frame) => frame.status === "active");
  const connected = frames.filter((frame) => frame.connected);

  return (
    // noCapture: frame names and owner emails.
    <AppShell isSuperadmin noCapture title="Frames">
      <div className="content-header">
        <div>
          <p className="copy">
            Every cloud-managed frame, online ones first. Only the control
            plane&apos;s view is listed — never a device key, scene, or
            screenshot.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        <form action="/admin/frames" className="inline-actions" method="get">
          <input
            className="input"
            defaultValue={query ?? ""}
            name="q"
            placeholder="Search by name, version, or owner"
            type="search"
          />
          <button className="button" type="submit">
            Search
          </button>
          <span className="copy">
            {active.length}/{frames.length} active · {connected.length} online
            {frames.length === 200 ? " (first 200)" : ""}
          </span>
        </form>

        {frames.length === 0 ? (
          <section className="card">
            <p>No matching frames.</p>
          </section>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Frame</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Hardware</th>
                  <th>Version</th>
                  <th>Last seen</th>
                  <th>Enrolled</th>
                </tr>
              </thead>
              <tbody>
                {frames.map((frame) => (
                  <tr
                    className={frame.status === "revoked" ? "row-muted" : undefined}
                    key={frame.id}
                  >
                    <td>
                      <div>{frame.name}</div>
                      <div className="copy">
                        <code>{frame.id.slice(0, 8)}</code>
                      </div>
                    </td>
                    <td>
                      <div>{frame.ownerName ?? "—"}</div>
                      <div className="copy">
                        <Link
                          href={`/admin/users?q=${encodeURIComponent(frame.ownerEmail ?? "")}`}
                        >
                          {frame.ownerEmail ?? "no email"}
                        </Link>
                      </div>
                    </td>
                    <td>
                      <div className="inline-actions">
                        {frame.status === "active" ? (
                          <span className="pill pill-ok">Active</span>
                        ) : frame.status === "pending" ? (
                          <span className="pill">Pending</span>
                        ) : (
                          <span className="pill pill-warning">{frame.status}</span>
                        )}
                        {frame.connected ? (
                          <span className="pill pill-ok">Online</span>
                        ) : null}
                      </div>
                    </td>
                    <td>{hardwareLabel(frame.hardware)}</td>
                    <td className="cell-nowrap">{frame.frameosVersion ?? "—"}</td>
                    <td className="cell-nowrap">
                      {frame.lastSeenAt ? formatDateTime(frame.lastSeenAt) : "never"}
                    </td>
                    <td className="cell-nowrap">{formatDate(frame.createdAt)}</td>
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

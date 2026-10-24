import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
import { SortableTable } from "../../../src/components/SortableTable";
import { listPhotoScanHitsForAdmin } from "../../../src/lib/admin";
import { requireSuperadmin } from "../../../src/lib/admin-page";
import { formatDateTime } from "../../../src/lib/format";
import { activePhotoScanners } from "../../../src/lib/photos/scan";

export const metadata = { title: "Photo scans" };

const scannerLabels: Record<string, string> = {
  hash_list: "Hash list",
  photodna: "PhotoDNA",
};

// Every photo upload that a scanner matched (docs/photos.md "Scanning"),
// newest first. Nothing of the image is kept; the row is the evidence.
export default async function AdminPhotosPage() {
  await requireSuperadmin("/admin/photos");

  const hits = await listPhotoScanHitsForAdmin(createDb());
  const scanners = activePhotoScanners();

  return (
    // noCapture: the rows carry account emails and client addresses.
    <AppShell isSuperadmin noCapture title="Photo scans">
      <div className="content-header">
        <div>
          <p className="copy">
            Photo uploads a scanner matched, newest first. The upload was
            refused and the account&apos;s photos were suspended (uploads
            refused, share links answer 404). Reporting a confirmed match to
            NCMEC is a manual step. Active scanners:{" "}
            {scanners.map((scanner) => scannerLabels[scanner] ?? scanner).join(", ")}.
          </p>
        </div>
      </div>

      <AdminNav />

      <section className="section-block">
        {hits.length === 0 ? (
          <section className="card">
            <p>No scan matches.</p>
          </section>
        ) : (
          <SortableTable
            columns={[
              { key: "time", label: "Time" },
              { key: "account", label: "Account" },
              { key: "scanner", label: "Scanner" },
              { key: "sha", label: "SHA-256" },
              { key: "address", label: "Address" },
            ]}
            rows={hits.map((hit) => ({
              cells: [
                formatDateTime(hit.createdAt),
                <span className="copy">
                  {hit.currentEmail ?? hit.accountEmail ?? "unknown"}
                  {hit.accountId ? null : <span className="risk-badge">deleted</span>}
                  {hit.photosSuspendedAt ? (
                    <span className="risk-badge">suspended</span>
                  ) : null}
                </span>,
                scannerLabels[hit.scanner] ?? hit.scanner,
                <code>{hit.sha256}</code>,
                <span className="copy">{hit.clientIp ?? "unknown"}</span>,
              ],
              key: hit.id,
              sort: [
                hit.createdAt.getTime(),
                hit.currentEmail ?? hit.accountEmail,
                scannerLabels[hit.scanner] ?? hit.scanner,
                hit.sha256,
                hit.clientIp,
              ],
            }))}
          />
        )}
      </section>
    </AppShell>
  );
}

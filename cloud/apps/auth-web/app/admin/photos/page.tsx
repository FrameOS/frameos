import { createDb } from "@frameos-cloud/db";
import { AdminNav } from "../../../src/components/AdminNav";
import { AppShell } from "../../../src/components/AppShell";
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
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Account</th>
                  <th>Scanner</th>
                  <th>SHA-256</th>
                  <th>Address</th>
                </tr>
              </thead>
              <tbody>
                {hits.map((hit) => (
                  <tr key={hit.id}>
                    <td>{formatDateTime(hit.createdAt)}</td>
                    <td className="copy">
                      {hit.currentEmail ?? hit.accountEmail ?? "unknown"}
                      {hit.accountId ? null : <span className="risk-badge">deleted</span>}
                      {hit.photosSuspendedAt ? (
                        <span className="risk-badge">suspended</span>
                      ) : null}
                    </td>
                    <td>{scannerLabels[hit.scanner] ?? hit.scanner}</td>
                    <td>
                      <code>{hit.sha256}</code>
                    </td>
                    <td className="copy">{hit.clientIp ?? "unknown"}</td>
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

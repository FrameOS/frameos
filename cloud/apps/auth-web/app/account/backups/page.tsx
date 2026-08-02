import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Download } from "lucide-react";
import { clientBackups, createDb, linkedClients } from "@frameos-cloud/db";
import { DeleteBackupButton } from "../../../src/components/DeleteBackupButton";
import { getAccountUrl } from "../../../src/lib/env";
import {
  backupKindLabel,
  maxBackupsPerAccount,
} from "../../../src/lib/backups";
import { formatBytes, formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Cloud backups" };

export default async function AccountBackupsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string }>;
}) {
  const backupsUrl = getAccountUrl("/account/backups");
  const session = await readSession();
  const accountId = session?.accountId;
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 100) ?? "";
  const kind = ["frames", "templates"].includes(params.kind ?? "")
    ? params.kind
    : "";

  const conditions: SQL[] = accountId
    ? [eq(clientBackups.accountId, accountId)]
    : [];
  if (query) {
    const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    const match = or(
      ilike(clientBackups.name, pattern),
      ilike(clientBackups.itemKey, pattern),
      ilike(linkedClients.publicDisplayName, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  if (kind) {
    conditions.push(eq(clientBackups.kind, kind));
  }

  const backupRows = accountId
    ? await createDb()
        .select({
          contentType: clientBackups.contentType,
          id: clientBackups.id,
          itemKey: clientBackups.itemKey,
          kind: clientBackups.kind,
          name: clientBackups.name,
          pushedBy: linkedClients.publicDisplayName,
          sizeBytes: clientBackups.sizeBytes,
          updatedAt: clientBackups.updatedAt,
        })
        .from(clientBackups)
        .leftJoin(
          linkedClients,
          eq(linkedClients.id, clientBackups.linkedClientId),
        )
        .where(and(...conditions))
        .orderBy(clientBackups.kind, desc(clientBackups.updatedAt))
    : [];

  const totalBackupBytes = backupRows.reduce(
    (sum, row) => sum + row.sizeBytes,
    0,
  );

  return (
    <section className="section-block">
      <div className="content-header compact-header">
        <div>
          <h2>Cloud backups</h2>
          <p className="copy">
            Frame configurations and scenes pushed by your linked backends,
            encrypted with your backup key before upload — we only store
            ciphertext. Backups belong to this account, so a reinstalled
            backend that relinks (and imports your backup recovery key) can
            restore them.
            {backupRows.length > 0
              ? ` Using ${backupRows.length} of ${maxBackupsPerAccount} items, ${formatBytes(totalBackupBytes)} total.`
              : ""}
          </p>
        </div>
      </div>
      <form action={backupsUrl} className="filter-bar" method="get">
        <input
          aria-label="Search backups"
          className="input filter-bar__search"
          defaultValue={query}
          name="q"
          placeholder="Search name, key, or device…"
          type="search"
        />
        <select
          aria-label="Kind"
          className="input filter-bar__select"
          defaultValue={kind}
          name="kind"
        >
          <option value="">All kinds</option>
          <option value="frames">Frames</option>
          <option value="templates">Scenes</option>
        </select>
        <button className="button button--small" type="submit">
          Filter
        </button>
        {query || kind ? (
          <Link
            className="button button--small button--subtle"
            href={backupsUrl}
          >
            Clear
          </Link>
        ) : null}
      </form>
      {backupRows.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Size</th>
              <th>Pushed by</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {backupRows.map((backup) => {
              const label = backup.name ?? backup.itemKey;
              return (
                <tr key={backup.id}>
                  <td>
                    <div>{label}</div>
                    {backup.name && backup.name !== backup.itemKey ? (
                      <div className="copy">{backup.itemKey}</div>
                    ) : null}
                  </td>
                  <td>{backupKindLabel(backup.kind)}</td>
                  <td>{formatBytes(backup.sizeBytes)}</td>
                  <td>{backup.pushedBy ?? "Unlinked device"}</td>
                  <td>{formatDateTime(backup.updatedAt)}</td>
                  <td>
                    <div className="inline-actions">
                      <a
                        className="button button--small"
                        href={`/api/account/backups/${backup.id}`}
                      >
                        <Download aria-hidden size={16} />
                        Download
                      </a>
                      <DeleteBackupButton backupId={backup.id} label={label} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : query || kind ? (
        <section className="card">
          <p>No backups match these filters.</p>
        </section>
      ) : (
        <section className="card">
          <p>
            No backups yet. Enable cloud backups on a linked backend (Settings →
            FrameOS Cloud) and use “Back up now” — frames also back up
            automatically after every successful deploy.
          </p>
        </section>
      )}
    </section>
  );
}

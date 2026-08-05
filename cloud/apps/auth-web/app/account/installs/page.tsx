import { and, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import Link from "next/link";
import {
  connectedBackends,
  createDb,
  deviceAuthorizationRequests,
  frames,
  linkedClients,
} from "@frameos-cloud/db";
import { InstallRowMenu } from "../../../src/components/InstallRowMenu";
import { OpenBackendButton } from "../../../src/components/OpenBackendButton";
import { getAccountUrl } from "../../../src/lib/env";
import { linkedClientScopes } from "../../../src/lib/backend-auth";
import {
  baselineDeviceScopes,
  deviceScopeLabels,
} from "../../../src/lib/device-scopes";
import { formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Linked backends" };

function enabledFeatureLabels(providerClientMetadata: unknown) {
  return linkedClientScopes({ providerClientMetadata })
    .filter((scope) => !baselineDeviceScopes.has(scope))
    .map((scope) => deviceScopeLabels[scope] ?? scope);
}

export default async function AccountInstallsPage({
  searchParams,
}: {
  searchParams: Promise<{ revoked?: string }>;
}) {
  const installsUrl = getAccountUrl("/account/installs");
  const session = await readSession();
  const accountId = session?.accountId;
  const showRevoked = (await searchParams).revoked === "1";

  const db = accountId ? createDb() : null;
  const clientRows =
    db && accountId
      ? await db
          .select({
            clientKind: linkedClients.clientKind,
            createdAt: linkedClients.createdAt,
            id: linkedClients.id,
            lastSeenAt: linkedClients.lastSeenAt,
            lastSyncAt: connectedBackends.lastSyncAt,
            providerClientMetadata: linkedClients.providerClientMetadata,
            publicDisplayName: linkedClients.publicDisplayName,
            reportedFrameosVersion: connectedBackends.reportedFrameosVersion,
            revokedAt: linkedClients.revokedAt,
          })
          .from(linkedClients)
          .leftJoin(
            connectedBackends,
            eq(connectedBackends.linkedClientId, linkedClients.id),
          )
          .where(
            and(
              eq(linkedClients.accountId, accountId),
              // Cloud-managed frames (claim-token or link-code enrollment)
              // each carry a linkedClients row too, but they live on the
              // Frames page — listing them here twice as "backends" was just
              // confusing. What remains: self-managed backends and frames
              // that link to the cloud for services (login, backups) without
              // handing over management. Those have no `frames` row.
              notExists(
                db
                  .select({ id: frames.id })
                  .from(frames)
                  .where(eq(frames.linkedClientId, linkedClients.id)),
              ),
            ),
          )
          .orderBy(desc(linkedClients.createdAt))
      : [];

  // The local origin each backend reported when it linked (from its device
  // authorization request) — lets "Open" load the backend UI from here.
  const originRows =
    db && clientRows.length > 0
      ? await db
          .select({
            linkedClientId: deviceAuthorizationRequests.linkedClientId,
            localOrigin: sql<string>`max(${deviceAuthorizationRequests.localOrigin})`,
          })
          .from(deviceAuthorizationRequests)
          .where(
            inArray(
              deviceAuthorizationRequests.linkedClientId,
              clientRows.map((client) => client.id),
            ),
          )
          .groupBy(deviceAuthorizationRequests.linkedClientId)
      : [];
  const originsByClient = new Map(
    originRows.map((row) => [row.linkedClientId, row.localOrigin]),
  );

  const revokedCount = clientRows.filter((client) => client.revokedAt).length;
  const visibleRows = showRevoked
    ? clientRows
    : clientRows.filter((client) => !client.revokedAt);

  return (
    <section className="section-block">
      <div className="content-header compact-header">
        <div>
          <h2>Linked backends</h2>
          <p className="copy">
            Self-managed frames and backends that link to your account for
            cloud services like login and backups. Cloud-managed frames live
            under Frames.{" "}
            <a
              href="https://frameos.net/guide/"
              rel="noreferrer noopener"
              target="_blank"
            >
              Installation instructions
            </a>
            .
          </p>
        </div>
        <div className="inline-actions">
          {revokedCount > 0 ? (
            <Link
              className="button button--subtle button--small"
              href={showRevoked ? installsUrl : `${installsUrl}?revoked=1`}
            >
              {showRevoked ? "Hide revoked" : `Show ${revokedCount} revoked`}
            </Link>
          ) : null}
          <Link className="button button--small" href="/device">
            Connect
          </Link>
        </div>
      </div>
      {visibleRows.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Enabled features</th>
              <th>Version</th>
              <th>Last seen</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((client) => {
              const features = enabledFeatureLabels(
                client.providerClientMetadata,
              );
              const lastSeen = client.lastSyncAt ?? client.lastSeenAt;
              const origin = originsByClient.get(client.id);
              const canOpen =
                !client.revokedAt &&
                client.clientKind !== "frame" &&
                typeof origin === "string" &&
                /^https?:\/\//.test(origin);
              return (
                <tr key={client.id}>
                  <td>{client.publicDisplayName}</td>
                  <td>{client.clientKind === "frame" ? "Frame" : "Backend"}</td>
                  <td>
                    {features.length > 0 ? (
                      <div className="inline-actions">
                        {features.map((feature) => (
                          <span className="pill" key={feature}>
                            {feature}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="copy">Link only</span>
                    )}
                  </td>
                  <td>{client.reportedFrameosVersion ?? "—"}</td>
                  <td>{lastSeen ? formatDateTime(lastSeen) : "Never"}</td>
                  <td>
                    <span
                      className={
                        client.revokedAt ? "pill pill-warning" : "pill pill-ok"
                      }
                    >
                      {client.revokedAt ? "Revoked" : "Active"}
                    </span>
                  </td>
                  <td>
                    <div className="inline-actions">
                      {canOpen ? (
                        <OpenBackendButton
                          id={client.id}
                          name={client.publicDisplayName}
                          origin={origin}
                        />
                      ) : null}
                      {client.revokedAt ? null : (
                        <InstallRowMenu
                          linkedClientId={client.id}
                          name={client.publicDisplayName}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <section className="card">
          <p>
            {clientRows.length > 0
              ? "No active links — every link on this account is revoked."
              : "No linked backends yet."}
          </p>
        </section>
      )}
    </section>
  );
}

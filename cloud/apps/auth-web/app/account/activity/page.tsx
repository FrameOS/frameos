import { and, desc, eq, ne } from "drizzle-orm";
import { auditEvents, createDb } from "@frameos-cloud/db";
import {
  auditEventDetail,
  auditEventLabel,
} from "../../../src/lib/audit-labels";
import { formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Recent activity" };

const activityLimit = 50;

export default async function AccountActivityPage() {
  const session = await readSession();
  const accountId = session?.accountId;

  const activityRows = accountId
    ? await createDb()
        .select({
          actor: auditEvents.actor,
          createdAt: auditEvents.createdAt,
          eventType: auditEvents.eventType,
          id: auditEvents.id,
          metadata: auditEvents.metadata,
        })
        .from(auditEvents)
        // Inventory heartbeats fire every few minutes and would fill the
        // whole feed; the installs page shows the last sync instead.
        .where(
          and(
            eq(auditEvents.accountId, accountId),
            ne(auditEvents.eventType, "backend.inventory_synced"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(activityLimit)
    : [];

  return (
    <section className="section-block">
      <div className="content-header compact-header">
        <div>
          <h2>Recent activity</h2>
          <p className="copy">
            The latest events on this account: sign-ins, device links, scope
            changes, and backup activity.
          </p>
        </div>
      </div>
      {activityRows.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Detail</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {activityRows.map((event) => (
              <tr key={event.id}>
                <td>{formatDateTime(event.createdAt)}</td>
                <td>{auditEventLabel(event.eventType)}</td>
                <td>{auditEventDetail(event.metadata) ?? "—"}</td>
                <td>
                  {typeof (event.actor as { ip?: unknown })?.ip === "string"
                    ? String((event.actor as { ip?: unknown }).ip)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <section className="card">
          <p>No activity recorded yet.</p>
        </section>
      )}
    </section>
  );
}

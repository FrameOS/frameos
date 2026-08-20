import { and, desc, eq, inArray, ne } from "drizzle-orm";
import Link from "next/link";
import { auditEvents, createDb, frames, storeScenes } from "@frameos-cloud/db";
import { cloudFrameUrl } from "@frameos/cloud-frontend/src/routes";
import {
  auditEventDetail,
  auditEventLabel,
  auditEventTarget,
} from "../../../src/lib/audit-labels";
import { formatDateTime } from "../../../src/lib/format";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Recent activity" };

const activityLimit = 50;

export default async function AccountActivityPage() {
  const session = await readSession();
  const accountId = session?.accountId;

  const db = accountId ? createDb() : undefined;
  const activityRows =
    db && accountId
      ? await db
          .select({
            actor: auditEvents.actor,
            createdAt: auditEvents.createdAt,
            eventType: auditEvents.eventType,
            id: auditEvents.id,
            metadata: auditEvents.metadata,
            target: auditEvents.target,
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

  // Resolve the frame / scene each row is about to a name. Two batched
  // lookups, scoped to the account so a row can never label a foreign id.
  // A frame deleted since the event keeps its row; it just shows no name.
  const targets = activityRows.map((row) => auditEventTarget(row.target));
  const frameIds = [
    ...new Set(targets.flatMap((t) => (t.frameId ? [t.frameId] : []))),
  ];
  const sceneIds = [
    ...new Set(targets.flatMap((t) => (t.sceneId ? [t.sceneId] : []))),
  ];
  const [frameRows, sceneRows] = await Promise.all([
    db && accountId && frameIds.length > 0
      ? db
          .select({ id: frames.id, name: frames.name })
          .from(frames)
          .where(
            and(eq(frames.accountId, accountId), inArray(frames.id, frameIds)),
          )
      : [],
    db && accountId && sceneIds.length > 0
      ? db
          .select({ id: storeScenes.id, name: storeScenes.name })
          .from(storeScenes)
          .where(
            and(
              eq(storeScenes.accountId, accountId),
              inArray(storeScenes.id, sceneIds),
            ),
          )
      : [],
  ]);
  const frameNames = new Map(frameRows.map((f) => [f.id, f.name]));
  const sceneNames = new Map(sceneRows.map((s) => [s.id, s.name]));

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
              <th>Frame / scene</th>
              <th>Detail</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {activityRows.map((event, index) => {
              const target = targets[index] ?? {};
              const frameName = target.frameId
                ? frameNames.get(target.frameId)
                : undefined;
              const sceneName = target.sceneId
                ? sceneNames.get(target.sceneId)
                : undefined;
              return (
                <tr key={event.id}>
                  <td>{formatDateTime(event.createdAt)}</td>
                  <td>{auditEventLabel(event.eventType)}</td>
                  <td>
                    {frameName && target.frameId ? (
                      <Link href={cloudFrameUrl(target.frameId)}>
                        {frameName}
                      </Link>
                    ) : sceneName ? (
                      sceneName
                    ) : target.frameId ? (
                      <span style={{ opacity: 0.6 }}>deleted frame</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{auditEventDetail(event.metadata) ?? "—"}</td>
                  <td>
                    {typeof (event.actor as { ip?: unknown })?.ip === "string"
                      ? String((event.actor as { ip?: unknown }).ip)
                      : "—"}
                  </td>
                </tr>
              );
            })}
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

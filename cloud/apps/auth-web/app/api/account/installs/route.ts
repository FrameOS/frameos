import { and, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import {
  connectedBackends,
  deviceAuthorizationRequests,
  frames,
  linkedClients,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { linkedClientScopes } from "../../../../src/lib/backend-auth";
import {
  baselineDeviceScopes,
  deviceScopeLabels,
} from "../../../../src/lib/device-scopes";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// The account's linked backends, for the Backends page of the frames
// workspace (frontend/src/scenes/settings/account/BackendsPage.tsx): the
// self-managed backends and frames that link to the account for cloud
// services (login, backups) without handing over management.
//
// Cloud-managed frames (claim-token or link-code enrollment) each carry a
// linkedClients row too, but they live in the Frames workspace — listing
// them here twice as "backends" was just confusing. What remains has no
// `frames` row. Revoked links are included (`revoked_at` set) so the page
// can offer to show them; revoking is POST /api/device/revoke.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:installs", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const accountId = session.accountId;

  const clientRows = await db
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
        notExists(
          db
            .select({ id: frames.id })
            .from(frames)
            .where(eq(frames.linkedClientId, linkedClients.id)),
        ),
      ),
    )
    .orderBy(desc(linkedClients.createdAt));

  // The local origin each backend reported when it linked (from its device
  // authorization request) — lets "Open" load the backend UI from the page.
  const originRows =
    clientRows.length > 0
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

  return NextResponse.json(
    {
      installs: clientRows.map((client) => {
        const origin = originsByClient.get(client.id);
        const canOpen =
          !client.revokedAt &&
          client.clientKind !== "frame" &&
          typeof origin === "string" &&
          /^https?:\/\//.test(origin);
        const lastSeen = client.lastSyncAt ?? client.lastSeenAt;
        return {
          created_at: client.createdAt.toISOString(),
          features: linkedClientScopes(client)
            .filter((scope) => !baselineDeviceScopes.has(scope))
            .map((scope) => deviceScopeLabels[scope] ?? scope),
          id: client.id,
          kind: client.clientKind === "frame" ? "frame" : "backend",
          last_seen_at: lastSeen ? lastSeen.toISOString() : null,
          name: client.publicDisplayName,
          origin: canOpen ? origin : null,
          revoked_at: client.revokedAt?.toISOString() ?? null,
          version: client.reportedFrameosVersion ?? null,
        };
      }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

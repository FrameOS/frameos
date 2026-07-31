import { eq } from "drizzle-orm";
import {
  connectedBackends,
  linkedClients,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { authenticateLinkedClient } from "../../../../src/lib/backend-auth";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request, "backend:inventory", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }

  const body = await readJsonObject(request);
  const reportedFrameosVersion = optionalString(body.reported_frameos_version);
  const capabilities = jsonRecord(body.capabilities);
  const health = jsonRecord(body.health);

  const [existingBackend] = await db
    .select({ id: connectedBackends.id })
    .from(connectedBackends)
    .where(eq(connectedBackends.linkedClientId, linkedClient.id))
    .limit(1);

  let backendId = existingBackend?.id;
  if (backendId) {
    await db
      .update(connectedBackends)
      .set({
        capabilities,
        lastHealthPayload: health,
        lastSyncAt: new Date(),
        reportedFrameosVersion,
        updatedAt: new Date(),
      })
      .where(eq(connectedBackends.id, backendId));
  } else {
    const [createdBackend] = await db
      .insert(connectedBackends)
      .values({
        capabilities,
        lastHealthPayload: health,
        lastSyncAt: new Date(),
        linkedClientId: linkedClient.id,
        reportedFrameosVersion,
      })
      .returning({ id: connectedBackends.id });

    if (!createdBackend) {
      return jsonError("backend_sync_failed", 500);
    }
    backendId = createdBackend.id;
  }

  await db
    .update(linkedClients)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(linkedClients.id, linkedClient.id));

  await recordAuditEvent(db, {
    accountId: linkedClient.accountId,
    actor: { linkedClientId: linkedClient.id },
    eventType: "backend.inventory_synced",
    metadata: { capabilitiesReported: Object.keys(capabilities).length > 0 },
    target: { backendId },
  });

  return NextResponse.json({
    backend_id: backendId,
    linked_client_id: linkedClient.id,
    status: "synced",
  });
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

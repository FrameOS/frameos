import { and, eq } from "drizzle-orm";
import { clientBackups } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
} from "../../../../../src/lib/backend-auth";
import {
  backupScopeForKind,
  backupSummary,
} from "../../../../../src/lib/backups";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ backupId: string }> };

async function loadBackup(
  request: NextRequest,
  context: RouteContext,
) {
  const limited = rateLimitResponse(request, "backend:backups", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return { errorResponse: limited };
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return { errorResponse: response };
  }

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return { errorResponse: jsonError("invalid_link_token", 401) };
  }

  const { backupId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(backupId)) {
    return { errorResponse: jsonError("backup_not_found", 404) };
  }

  const [backup] = await db
    .select()
    .from(clientBackups)
    .where(
      and(
        eq(clientBackups.id, backupId),
        eq(clientBackups.accountId, linkedClient.accountId),
      ),
    )
    .limit(1);

  if (!backup) {
    return { errorResponse: jsonError("backup_not_found", 404) };
  }

  const requiredScope = backupScopeForKind(backup.kind);
  if (!requiredScope || !linkedClientHasScope(linkedClient, requiredScope)) {
    return { errorResponse: jsonError("insufficient_scope", 403) };
  }

  return { backup, db, linkedClient };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { backup, errorResponse } = await loadBackup(request, context);
  if (!backup) {
    return errorResponse;
  }

  return NextResponse.json({
    backup: {
      ...backupSummary(backup),
      content_base64: Buffer.from(backup.content).toString("base64"),
    },
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { backup, db, errorResponse, linkedClient } = await loadBackup(
    request,
    context,
  );
  if (!backup || !db || !linkedClient) {
    return errorResponse;
  }

  await db.delete(clientBackups).where(eq(clientBackups.id, backup.id));

  await recordAuditEvent(db, {
    accountId: linkedClient.accountId,
    actor: { linkedClientId: linkedClient.id },
    eventType: "backup.deleted",
    metadata: { itemKey: backup.itemKey, kind: backup.kind },
    target: { backupId: backup.id },
  });

  return NextResponse.json({ status: "deleted" });
}

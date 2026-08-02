import { and, eq } from "drizzle-orm";
import { clientBackups } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { backupDownloadFileName } from "../../../../../src/lib/backups";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ backupId: string }> };

// Session-authenticated access to the account's own config backups, for the
// account page. Linked backends and frames use the bearer-token routes under
// /api/backends/backups instead; those are scope-checked per kind, while the
// signed-in owner may always see and manage everything the account stores.
async function loadBackup(request: NextRequest, context: RouteContext) {
  const limited = rateLimitResponse(request, "account:backups", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return { errorResponse: limited };
  }

  const session = await readSession();
  if (!session?.accountId) {
    return { errorResponse: jsonError("login_required", 401) };
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return { errorResponse: response };
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
        eq(clientBackups.accountId, session.accountId),
      ),
    )
    .limit(1);

  if (!backup) {
    return { errorResponse: jsonError("backup_not_found", 404) };
  }

  return { backup, db, session };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { backup, errorResponse } = await loadBackup(request, context);
  if (!backup) {
    return errorResponse;
  }

  return new NextResponse(Buffer.from(backup.content), {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${backupDownloadFileName(backup)}"`,
      "content-length": String(backup.content.length),
      "content-type": backup.contentType ?? "application/octet-stream",
    },
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const { backup, db, errorResponse, session } = await loadBackup(
    request,
    context,
  );
  if (!backup || !db || !session) {
    return errorResponse;
  }

  await db.delete(clientBackups).where(eq(clientBackups.id, backup.id));

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "backup.deleted",
    metadata: { itemKey: backup.itemKey, kind: backup.kind },
    target: { backupId: backup.id },
  });

  return NextResponse.json({ status: "deleted" });
}

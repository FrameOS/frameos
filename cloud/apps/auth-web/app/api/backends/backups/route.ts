import { and, eq, inArray, sql } from "drizzle-orm";
import { clientBackups } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
  linkedClientScopes,
} from "../../../../src/lib/backend-auth";
import {
  backupKindScopes,
  backupScopeForKind,
  backupSummary,
  decodeBackupContent,
  maxBackupBytes,
  maxBackupsPerAccount,
  sha256Hex,
} from "../../../../src/lib/backups";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { accountLimits } from "../../../../src/lib/usage";

export const runtime = "nodejs";

// List the account's config backups, restricted to the kinds this linked
// client's scopes allow it to see. Backups are account-owned: a reinstalled
// backend that relinked to the same account sees backups pushed by the old
// install, which is exactly what "Restore from FrameOS Cloud" needs.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "backend:backups", {
    limit: 240,
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

  const scopes = linkedClientScopes(linkedClient);
  const visibleKinds = Object.entries(backupKindScopes)
    .filter(([, scope]) => scopes.includes(scope))
    .map(([kind]) => kind);
  if (visibleKinds.length === 0) {
    return jsonError("insufficient_scope", 403);
  }

  const rows = await db
    .select({
      contentType: clientBackups.contentType,
      createdAt: clientBackups.createdAt,
      id: clientBackups.id,
      itemKey: clientBackups.itemKey,
      kind: clientBackups.kind,
      linkedClientId: clientBackups.linkedClientId,
      name: clientBackups.name,
      sha256: clientBackups.sha256,
      sizeBytes: clientBackups.sizeBytes,
      updatedAt: clientBackups.updatedAt,
    })
    .from(clientBackups)
    .where(
      and(
        eq(clientBackups.accountId, linkedClient.accountId),
        inArray(clientBackups.kind, visibleKinds),
      ),
    )
    .orderBy(clientBackups.kind, clientBackups.itemKey);

  return NextResponse.json({
    backups: rows.map(backupSummary),
    linked_client_id: linkedClient.id,
  });
}

// Save (or replace) one config backup blob.
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "backend:backups", {
    limit: 240,
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
  const kind = typeof body.kind === "string" ? body.kind : "";
  const requiredScope = backupScopeForKind(kind);
  if (!requiredScope) {
    return jsonError("invalid_backup_kind", 400);
  }
  if (!linkedClientHasScope(linkedClient, requiredScope)) {
    return jsonError("insufficient_scope", 403);
  }

  const itemKey = parseOptionalString(body.item_key);
  if (!itemKey || itemKey.length > 256) {
    return jsonError("invalid_item_key", 400);
  }

  const content = decodeBackupContent(body.content_base64);
  if (!content || content.length === 0) {
    return jsonError("invalid_content", 400);
  }
  if (content.length > maxBackupBytes) {
    return jsonError("backup_too_large", 413, {
      max_bytes: maxBackupBytes,
    });
  }

  const name = parseOptionalString(body.name)?.slice(0, 256);
  const contentType = parseOptionalString(body.content_type)?.slice(0, 128);

  // Count quota (replacing an existing item never fails it) plus the account
  // byte quota — replacements only count the size delta, so re-uploading a
  // same-size backup always succeeds even at the limit.
  const [countRow] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${clientBackups.sizeBytes}), 0)::float8`,
      count: sql<number>`count(*)::int`,
    })
    .from(clientBackups)
    .where(eq(clientBackups.accountId, linkedClient.accountId));
  const count = countRow?.count ?? 0;
  const accountBytes = Number(countRow?.bytes ?? 0);
  const [existing] = await db
    .select({ id: clientBackups.id, sizeBytes: clientBackups.sizeBytes })
    .from(clientBackups)
    .where(
      and(
        eq(clientBackups.accountId, linkedClient.accountId),
        eq(clientBackups.kind, kind),
        eq(clientBackups.itemKey, itemKey),
      ),
    )
    .limit(1);
  if (!existing && count >= maxBackupsPerAccount) {
    return jsonError("backup_quota_exceeded", 403, {
      max_backups: maxBackupsPerAccount,
    });
  }
  const bytesAfterSave =
    accountBytes - (existing?.sizeBytes ?? 0) + content.length;
  // The plan's account budget, not the free tier's: the number that refuses
  // has to be the number the account page promises (src/lib/usage.ts).
  // Distinct from `maxBackupBytes` above, which caps ONE backup.
  const { backupBytes: maxAccountBackupBytes } = await accountLimits(
    db,
    linkedClient.accountId,
  );
  if (bytesAfterSave > maxAccountBackupBytes) {
    return jsonError("backup_storage_quota_exceeded", 403, {
      max_bytes: maxAccountBackupBytes,
      used_bytes: Math.round(accountBytes),
    });
  }

  const values = {
    accountId: linkedClient.accountId,
    content,
    contentType: contentType ?? null,
    itemKey,
    kind,
    linkedClientId: linkedClient.id,
    name: name ?? null,
    sha256: sha256Hex(content),
    sizeBytes: content.length,
  };

  const [saved] = await db
    .insert(clientBackups)
    .values(values)
    .onConflictDoUpdate({
      set: { ...values, updatedAt: new Date() },
      target: [
        clientBackups.accountId,
        clientBackups.kind,
        clientBackups.itemKey,
      ],
    })
    .returning({
      contentType: clientBackups.contentType,
      createdAt: clientBackups.createdAt,
      id: clientBackups.id,
      itemKey: clientBackups.itemKey,
      kind: clientBackups.kind,
      linkedClientId: clientBackups.linkedClientId,
      name: clientBackups.name,
      sha256: clientBackups.sha256,
      sizeBytes: clientBackups.sizeBytes,
      updatedAt: clientBackups.updatedAt,
    });

  if (!saved) {
    return jsonError("backup_save_failed", 500);
  }

  await recordAuditEvent(db, {
    accountId: linkedClient.accountId,
    actor: { linkedClientId: linkedClient.id },
    eventType: "backup.saved",
    metadata: { itemKey, kind, sizeBytes: content.length },
    target: { backupId: saved.id },
  });

  return NextResponse.json({ backup: backupSummary(saved), status: "saved" });
}

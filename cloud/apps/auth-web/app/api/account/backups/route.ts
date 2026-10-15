import { desc, eq } from "drizzle-orm";
import { clientBackups, linkedClients } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  backupKindLabel,
  maxBackupsPerAccount,
} from "../../../../src/lib/backups";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// The account's config backups, for the Backups page of the frames
// workspace (frontend/src/scenes/settings/account/BackupsPage.tsx): every
// row the account holds, metadata only — the ciphertext is a download at
// /api/account/backups/{id} (the sibling [backupId] route, which also
// deletes). At most maxBackupsPerAccount rows, so the page filters itself.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:backups-list", {
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

  const rows = await db
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
    .leftJoin(linkedClients, eq(linkedClients.id, clientBackups.linkedClientId))
    .where(eq(clientBackups.accountId, session.accountId))
    .orderBy(clientBackups.kind, desc(clientBackups.updatedAt));

  return NextResponse.json(
    {
      backups: rows.map((backup) => ({
        download_url: `/api/account/backups/${backup.id}`,
        id: backup.id,
        item_key: backup.itemKey,
        kind: backup.kind,
        kind_label: backupKindLabel(backup.kind),
        name: backup.name,
        pushed_by: backup.pushedBy ?? null,
        size_bytes: backup.sizeBytes,
        updated_at: backup.updatedAt.toISOString(),
      })),
      max_backups: maxBackupsPerAccount,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

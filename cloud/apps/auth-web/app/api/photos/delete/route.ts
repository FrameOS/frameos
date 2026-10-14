import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { deletePhotoEntries } from "../../../../src/lib/photos/library";
import { parsePhotoPathList } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// POST /api/photos/delete {"paths": [...]} -> {"deleted": n}. Folders go
// with everything in them, and so do the share links at or below them.
// Paths that are not there are skipped.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const parsed = await readBoundedJsonObject(request, 1024 * 1024);
  if (parsed.response) {
    return parsed.response;
  }
  const paths = parsePhotoPathList(parsed.body.paths);
  if (!paths) {
    return jsonError("invalid_paths", 400);
  }
  return withPhotoErrors(async () => {
    const result = await deletePhotoEntries(context.db, context.accountId, paths);
    // Files one at a time are not audited; a whole folder is worth a line in
    // the activity feed.
    for (const folder of result.folders) {
      await recordAuditEvent(context.db, {
        accountId: context.accountId,
        actor: { accountId: context.accountId, providerSubject: context.providerSubject },
        eventType: "photos.folder_deleted",
        metadata: { files: folder.files, path: folder.path },
      });
    }
    return NextResponse.json({ deleted: result.deleted });
  });
}

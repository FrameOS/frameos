import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { listPhotoFolder } from "../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// GET /api/photos/files?path=<folder>: the folder's direct children, folders
// first, then by name in natural order. 404 when the folder does not exist.
export async function GET(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "read" });
  if (context.response) {
    return context.response;
  }
  const folder = parsePhotoPath(request.nextUrl.searchParams.get("path") ?? "", {
    allowRoot: true,
  });
  if (folder === undefined) {
    return jsonError("invalid_path", 400);
  }
  return withPhotoErrors(async () => {
    const entries = await listPhotoFolder(context.db, context.accountId, folder);
    return NextResponse.json(
      { entries, path: folder },
      { headers: { "cache-control": "no-store" } },
    );
  });
}

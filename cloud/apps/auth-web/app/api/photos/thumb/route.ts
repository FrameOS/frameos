import { NextRequest } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { objectStore } from "../../../../src/lib/object-store";
import { photoBytesResponse, photoOwnerContext } from "../../../../src/lib/photos/http";
import { photoFileObjects } from "../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// GET /api/photos/thumb?path=<file>: the thumbnail the upload made, or 404
// when it could not make one (the SPA then shows the file itself).
export async function GET(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "read" });
  if (context.response) {
    return context.response;
  }
  const path = parsePhotoPath(request.nextUrl.searchParams.get("path"), { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  const row = await photoFileObjects(context.db, context.accountId, path);
  if (!row?.thumbObjectKey) {
    return jsonError("not_found", 404);
  }
  const bytes = await objectStore().get(row.thumbObjectKey);
  if (!bytes) {
    return jsonError("not_found", 404);
  }
  // The URL carries the file's mtime and size, so a replaced file gets a new
  // URL; the browser may keep this one for a day.
  return photoBytesResponse(bytes, {
    cacheControl: "private, max-age=86400",
    contentType: "image/jpeg",
  });
}

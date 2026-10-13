import { NextRequest } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { objectStore } from "../../../../src/lib/object-store";
import {
  contentDisposition,
  photoBytesResponse,
  photoOwnerContext,
} from "../../../../src/lib/photos/http";
import { photoFileObjects } from "../../../../src/lib/photos/library";
import { parsePhotoPath, photoBasename } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// GET /api/photos/file?path=<file>[&download=1]: the owner's own bytes,
// proxied (never the CDN: the owner's view must stop working the moment the
// session does), with inert headers.
export async function GET(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "read" });
  if (context.response) {
    return context.response;
  }
  const query = request.nextUrl.searchParams;
  const path = parsePhotoPath(query.get("path"), { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  const row = await photoFileObjects(context.db, context.accountId, path);
  if (!row?.objectKey) {
    return jsonError("not_found", 404);
  }
  const bytes = await objectStore().get(row.objectKey);
  if (!bytes) {
    return jsonError("not_found", 404);
  }
  const download = query.get("download") === "1";
  const isImage = Boolean(row.contentType?.startsWith("image/"));
  return photoBytesResponse(bytes, {
    cacheControl: "private, max-age=300",
    contentType: row.contentType,
    disposition: contentDisposition(
      download || !isImage ? "attachment" : "inline",
      photoBasename(path),
    ),
  });
}

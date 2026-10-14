import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { objectStore } from "../../../../../../src/lib/object-store";
import { photoBytesResponse, sharedPhotoContext } from "../../../../../../src/lib/photos/http";
import { sharedPhotoObject } from "../../../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// GET /api/photos/shared/{token}/file?path=<path>: one playable file below
// the shared folder (`path` relative to it). With a public CDN alias this is
// a 302 to the object's address there, so the bytes never pass through
// Next; without one the bytes are streamed. The redirect itself is never
// cached: revoking the link stops it at once.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const relative = parsePhotoPath(request.nextUrl.searchParams.get("path"), {
    allowRoot: false,
  });
  if (relative === undefined) {
    return jsonError("invalid_path", 400);
  }
  const context = await sharedPhotoContext(request, token);
  if (context.response) {
    return context.response;
  }
  const row = await sharedPhotoObject(context.db, context.share, relative);
  if (!row?.objectKey) {
    return jsonError("not_found", 404);
  }
  const store = objectStore();
  const publicUrl = store.publicUrl(row.objectKey);
  if (publicUrl) {
    return NextResponse.redirect(publicUrl, {
      headers: { "cache-control": "no-store" },
      status: 302,
    });
  }
  const bytes = await store.get(row.objectKey);
  if (!bytes) {
    return jsonError("not_found", 404);
  }
  // The URL carries the token: no shared cache keeps the bytes.
  return photoBytesResponse(bytes, {
    cacheControl: "private, max-age=300",
    contentType: row.contentType,
  });
}

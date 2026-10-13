import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedBytes } from "../../../../src/lib/device-flow";
import { objectStore } from "../../../../src/lib/object-store";
import {
  photoBytesResponse,
  photoOwnerContext,
  withPhotoErrors,
} from "../../../../src/lib/photos/http";
import { imageDimensions } from "../../../../src/lib/photos/image-info";
import { scanIncomingPhoto } from "../../../../src/lib/photos/intake";
import {
  maxPhotoThumbBytes,
  maxPhotoThumbSide,
  photoFileObjects,
  storePhotoThumb,
} from "../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";
import { detectImageContentType } from "../../../../src/lib/store";

export const runtime = "nodejs";

// GET /api/photos/thumb?path=<file>: the browser-made thumbnail, or 404 (the
// SPA then shows the file itself). Browser previews only.
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

// POST /api/photos/thumb?path=<file>: a raw JPEG of at most 512 KiB and 512
// px on the long side, stored as the file's thumbnail. It is scanned like
// any upload: every byte in the bucket passes the scan.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "upload" });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const path = parsePhotoPath(request.nextUrl.searchParams.get("path"), { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  const body = await readBoundedBytes(request, maxPhotoThumbBytes);
  if (!body) {
    return jsonError("invalid_body", 400);
  }
  if (body.overflow) {
    return jsonError("too_large", 413, { max_bytes: maxPhotoThumbBytes });
  }
  const bytes = body.bytes;
  if (detectImageContentType(bytes) !== "image/jpeg") {
    return jsonError("unsupported_type", 415, {
      accepts: ["image/jpeg"],
      message: "Thumbnails must be JPEG images.",
    });
  }
  const dimensions = imageDimensions(bytes, "image/jpeg");
  if (
    !dimensions ||
    dimensions.width > maxPhotoThumbSide ||
    dimensions.height > maxPhotoThumbSide
  ) {
    return jsonError("invalid_thumbnail", 400, {
      message: `Thumbnails can be at most ${maxPhotoThumbSide} pixels on the long side.`,
    });
  }
  return withPhotoErrors(async () => {
    const row = await photoFileObjects(db, accountId, path);
    if (!row) {
      return jsonError("not_found", 404);
    }
    const scanned = await scanIncomingPhoto(db, request, context, bytes, "image/jpeg");
    if (scanned.response) {
      return scanned.response;
    }
    await storePhotoThumb(db, accountId, path, bytes);
    return new NextResponse(null, { status: 204 });
  });
}

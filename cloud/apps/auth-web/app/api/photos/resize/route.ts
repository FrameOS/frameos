import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { scanIncomingPhoto } from "../../../../src/lib/photos/intake";
import { PhotoError, photoFileObjects, replacePhotoFile } from "../../../../src/lib/photos/library";
import { readPhotoMetadataBytes } from "../../../../src/lib/photos/metadata";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";
import { parseResizeOptions, resizePhotoBytes } from "../../../../src/lib/photos/resize";
import { makePhotoThumbnail } from "../../../../src/lib/photos/thumbnail";
import { objectStore } from "../../../../src/lib/object-store";

export const runtime = "nodejs";

// POST /api/photos/resize {"path": "Summer 2026/a.jpg", "width": 1600,
// "height": 1200, "fit": "inside", "format": "keep", "quality": 85} ->
// {"entry": Entry}. Replaces the photo with itself resized (docs/photos.md):
// new bytes, thumbnail, size and dimensions, the same entry otherwise (its
// colors, its place in the album, its date). A format change changes the
// extension; the returned entry has the path. The new bytes pass the scan
// like an upload: every byte stored has.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const { accountId, db, email } = context;
  const parsed = await readBoundedJsonObject(request);
  if (parsed.response) {
    return parsed.response;
  }
  const path = parsePhotoPath(parsed.body.path, { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  return withPhotoErrors(async () => {
    const options = parseResizeOptions(parsed.body);
    const current = await photoFileObjects(db, accountId, path);
    if (!current || current.status !== "ready" || !current.objectKey) {
      throw new PhotoError("not_found", 404);
    }
    if (!current.contentType?.startsWith("image/")) {
      throw new PhotoError("not_playable", 400);
    }
    const bytes = await objectStore().get(current.objectKey);
    if (!bytes) {
      throw new PhotoError("not_found", 404);
    }
    const resized = await resizePhotoBytes(bytes, options);
    const scanned = await scanIncomingPhoto(db, request, { accountId, email }, resized.bytes, resized.contentType);
    if (scanned.response) {
      return scanned.response;
    }
    const thumbnail = await makePhotoThumbnail(resized.bytes);
    const entry = await replacePhotoFile(db, accountId, path, {
      body: resized.bytes,
      contentType: resized.contentType,
      extension: resized.extension,
      height: resized.height,
      // What the re-encoded bytes carry (sharp writes no EXIF here).
      metadata: await readPhotoMetadataBytes(resized.bytes),
      sha256: scanned.sha256,
      size: resized.bytes.length,
      thumbnail,
      width: resized.width,
    });
    return NextResponse.json({ entry });
  });
}

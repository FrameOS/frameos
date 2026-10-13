import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { getPublicOrigin } from "../../../../src/lib/env";
import {
  buildPhotoAlbumScene,
  defaultPhotoAlbumSeconds,
  isPhotoAlbumFit,
  isPhotoAlbumOrder,
} from "../../../../src/lib/photos/album-scene";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { createPhotoShare, photoShareJson, photoShareUrl } from "../../../../src/lib/photos/library";
import { parsePhotoPath, photoBasename } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

const maxSceneNameLength = 256;

// POST /api/photos/scene {"path", "seconds"?, "order"?, "fit"?, "name"?} ->
// {"scene": Scene, "share": Share}: a ready scene that plays the folder,
// with the folder's share link in it (made now if it has none). Installing
// it is the frame routes' business. `frame_id` is the backend's (its links
// are relative to the address a frame dials); cloud links are absolute.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const parsed = await readBoundedJsonObject(request, 16 * 1024);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body;
  const path = parsePhotoPath(body.path, { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  const seconds = body.seconds ?? defaultPhotoAlbumSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return jsonError("invalid_seconds", 400);
  }
  const order = body.order ?? "random";
  if (!isPhotoAlbumOrder(order)) {
    return jsonError("invalid_order", 400);
  }
  const fit = body.fit ?? "cover";
  if (!isPhotoAlbumFit(fit)) {
    return jsonError("invalid_fit", 400);
  }
  const name = body.name ?? null;
  if (name !== null && (typeof name !== "string" || name.length > maxSceneNameLength)) {
    return jsonError("invalid_name", 400);
  }
  return withPhotoErrors(async () => {
    const { created, share } = await createPhotoShare(context.db, context.accountId, path);
    if (created) {
      await recordAuditEvent(context.db, {
        accountId: context.accountId,
        actor: { accountId: context.accountId, providerSubject: context.providerSubject },
        eventType: "photos.share_created",
        metadata: { path: share.path },
      });
    }
    const origin = getPublicOrigin(request);
    const scene = buildPhotoAlbumScene({
      albumUrl: photoShareUrl(origin, share.token),
      fit,
      name: (name ?? "").trim() || photoBasename(share.path),
      order,
      seconds,
    });
    return NextResponse.json({ scene, share: photoShareJson(share, origin) });
  });
}

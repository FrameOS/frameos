import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { sharedPhotoContext, sharedPhotoFileUrl } from "../../../../../../src/lib/photos/http";
import { sharedPhotos } from "../../../../../../src/lib/photos/library";
import { parsePhotoOrder, pickPhoto } from "../../../../../../src/lib/photos/pick";

export const runtime = "nodejs";

// GET /api/photos/shared/{token}/photo?order=<order>&index=<n>: one photo,
// so a frame never downloads the whole listing. The photo is the one at
// `index mod count` in the order; `random` shuffles per cycle, seeded by the
// token and floor(index / count) (src/lib/photos/pick.ts).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const query = request.nextUrl.searchParams;
  const order = parsePhotoOrder(query.get("order"));
  if (!order) {
    return jsonError("invalid_order", 400);
  }
  const rawIndex = query.get("index");
  const index = rawIndex === null || rawIndex === "" ? 0 : Number(rawIndex);
  if (!Number.isSafeInteger(index) || index < 0) {
    return jsonError("invalid_index", 400);
  }
  const context = await sharedPhotoContext(request, token);
  if (context.response) {
    return context.response;
  }
  const { db, origin, share } = context;
  const { photos } = await sharedPhotos(db, share);
  const picked = pickPhoto(photos, { index, order, token });
  const photo = picked.photo;
  return NextResponse.json(
    {
      count: picked.count,
      index: picked.index,
      photo: photo
        ? {
            content_type: photo.contentType,
            height: photo.height,
            mtime: photo.mtime,
            name: photo.name,
            path: photo.path,
            size: photo.size,
            url: sharedPhotoFileUrl(origin, token, photo.path),
            width: photo.width,
          }
        : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

import { NextRequest, NextResponse } from "next/server";
import { sharedPhotoContext, sharedPhotoJson } from "../../../../../src/lib/photos/http";
import { sharedPhotos } from "../../../../../src/lib/photos/library";

export const runtime = "nodejs";

// GET /api/photos/shared/{token}: every playable file below the shared
// folder, by path, at most 10000, each with its color profile (docs/photos.md).
// No login: the token is the credential.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const context = await sharedPhotoContext(request, token);
  if (context.response) {
    return context.response;
  }
  const { db, origin, share } = context;
  const { photos, updatedAt } = await sharedPhotos(db, share);
  return NextResponse.json(
    {
      count: photos.length,
      files: photos.map((photo) => sharedPhotoJson(origin, token, photo)),
      name: share.name,
      updated_at: updatedAt,
    },
    // A revoked link must stop listing at once.
    { headers: { "cache-control": "no-store" } },
  );
}

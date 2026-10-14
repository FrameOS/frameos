import { NextRequest, NextResponse } from "next/server";
import { photoOwnerContext } from "../../../../src/lib/photos/http";
import {
  acceptedPhotoContentTypes,
  maxPhotoUploadBytes,
  photoLibraryTotals,
  photosSuspendedAt,
  photosSuspendedMessage,
} from "../../../../src/lib/photos/library";
import { activePhotoScanners } from "../../../../src/lib/photos/scan";
import { maxPhotoBytesPerAccount } from "../../../../src/lib/usage";

export const runtime = "nodejs";

// GET /api/photos/status (docs/photos.md): whether the library can be used,
// and the numbers the Photos page needs before it uploads anything.
export async function GET(request: NextRequest) {
  const context = await photoOwnerContext(request, { allowUnavailable: true, kind: "read" });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const [suspendedAt, totals] = await Promise.all([
    photosSuspendedAt(db, accountId),
    photoLibraryTotals(db, accountId),
  ]);
  const suspended = Boolean(suspendedAt);
  return NextResponse.json(
    {
      accepts: [...acceptedPhotoContentTypes],
      free_bytes: null,
      location: null,
      max_upload_bytes: maxPhotoUploadBytes,
      message: suspended ? photosSuspendedMessage : null,
      problem: suspended ? "suspended" : null,
      quota_bytes: maxPhotoBytesPerAccount,
      ready: !suspended,
      scanning: activePhotoScanners(),
      used_bytes: Math.round(totals.bytes),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

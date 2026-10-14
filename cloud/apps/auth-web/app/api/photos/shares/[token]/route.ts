import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { jsonError } from "../../../../../src/lib/device-flow";
import { photoOwnerContext } from "../../../../../src/lib/photos/http";
import { deletePhotoShare, isPhotoShareToken } from "../../../../../src/lib/photos/library";

export const runtime = "nodejs";

// DELETE /api/photos/shares/{token} -> {"deleted": true}. Listings and
// redirects stop at once; a CDN address a frame already holds keeps working
// until the photo itself is deleted.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const { token } = await params;
  if (!isPhotoShareToken(token)) {
    return jsonError("not_found", 404);
  }
  const deleted = await deletePhotoShare(context.db, context.accountId, token);
  if (!deleted) {
    return jsonError("not_found", 404);
  }
  await recordAuditEvent(context.db, {
    accountId: context.accountId,
    actor: { accountId: context.accountId, providerSubject: context.providerSubject },
    eventType: "photos.share_deleted",
    metadata: { path: deleted.path },
  });
  return NextResponse.json({ deleted: true });
}

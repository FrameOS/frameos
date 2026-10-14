import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { getPublicOrigin } from "../../../../src/lib/env";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import {
  createPhotoShare,
  listPhotoShares,
  photoShareJson,
} from "../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// GET /api/photos/shares -> {"shares": [Share, ...]}. `url` is absolute: the
// address frames use to reach this cloud.
export async function GET(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "read" });
  if (context.response) {
    return context.response;
  }
  const origin = getPublicOrigin(request);
  const shares = await listPhotoShares(context.db, context.accountId);
  return NextResponse.json(
    { shares: shares.map((share) => photoShareJson(share, origin)) },
    { headers: { "cache-control": "no-store" } },
  );
}

// POST /api/photos/shares {"path": "Summer 2026"} -> {"share": Share}. One
// link per folder: an existing one is returned as it is.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const parsed = await readBoundedJsonObject(request, 16 * 1024);
  if (parsed.response) {
    return parsed.response;
  }
  const path = parsePhotoPath(parsed.body.path, { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
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
    return NextResponse.json({ share: photoShareJson(share, getPublicOrigin(request)) });
  });
}

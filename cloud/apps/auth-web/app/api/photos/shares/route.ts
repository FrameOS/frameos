import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { getPublicOrigin } from "../../../../src/lib/env";
import { frameForAccount, isFrameId } from "../../../../src/lib/frames";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import {
  createCustomPhotoShare,
  createPhotoShare,
  listPhotoShares,
  maxPhotoShareNameLength,
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

// POST /api/photos/shares {"path": "Summer 2026", "frame_id"?: uuid,
// "name"?: "Grandma"} -> {"share": Share}. The folder's general link, or with
// `frame_id` the link for that one frame (either returned as it is when it
// exists), or with `name` a new custom link every time.
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
  const rawName = parsed.body.name ?? null;
  if (rawName !== null) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || name.length > maxPhotoShareNameLength) {
      return jsonError("invalid_name", 400);
    }
    return withPhotoErrors(async () => {
      const share = await createCustomPhotoShare(context.db, context.accountId, path, name);
      await recordAuditEvent(context.db, {
        accountId: context.accountId,
        actor: { accountId: context.accountId, providerSubject: context.providerSubject },
        eventType: "photos.share_created",
        metadata: { name: share.name, path: share.path },
      });
      return NextResponse.json({ share: photoShareJson(share, getPublicOrigin(request)) });
    });
  }
  const frameId = parsed.body.frame_id ?? null;
  if (frameId !== null && !isFrameId(frameId)) {
    return jsonError("invalid_frame_id", 400);
  }
  if (frameId !== null && !(await frameForAccount(context.db, context.accountId, frameId))) {
    return jsonError("frame_not_found", 404);
  }
  return withPhotoErrors(async () => {
    const { created, share } = await createPhotoShare(context.db, context.accountId, path, frameId);
    if (created) {
      await recordAuditEvent(context.db, {
        accountId: context.accountId,
        actor: { accountId: context.accountId, providerSubject: context.providerSubject },
        eventType: "photos.share_created",
        metadata: { frameId: share.frameId, path: share.path },
      });
    }
    return NextResponse.json({ share: photoShareJson(share, getPublicOrigin(request)) });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { createPhotoFolder } from "../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// POST /api/photos/folders {"path": "Summer 2026/Beach"} -> {"entry": Entry}.
// Parents are created; 409 when the path exists.
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
    const entry = await createPhotoFolder(context.db, context.accountId, path);
    return NextResponse.json({ entry });
  });
}

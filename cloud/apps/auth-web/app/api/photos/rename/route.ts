import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { renamePhotoEntry } from "../../../../src/lib/photos/library";
import {
  isValidPhotoSegment,
  parsePhotoPath,
} from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// POST /api/photos/rename {"path": "Summer 2026/a.jpg", "name": "b.jpg"} ->
// {"entry": Entry}. 409 when the name is taken. Share links follow.
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
  const name = parsed.body.name;
  if (typeof name !== "string" || !isValidPhotoSegment(name)) {
    return jsonError("invalid_name", 400);
  }
  return withPhotoErrors(async () => {
    const entry = await renamePhotoEntry(context.db, context.accountId, path, name);
    return NextResponse.json({ entry });
  });
}

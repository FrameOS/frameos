import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { movePhotoEntries } from "../../../../src/lib/photos/library";
import { parsePhotoPath, parsePhotoPathList } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// POST /api/photos/move {"paths": [...], "to": "<folder>"} ->
// {"moved": [{"from", "to"}, ...]}. All or nothing: every path is checked
// first, and the whole move is one transaction. Share links follow.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const parsed = await readBoundedJsonObject(request, 1024 * 1024);
  if (parsed.response) {
    return parsed.response;
  }
  const to = parsePhotoPath(parsed.body.to, { allowRoot: true });
  if (to === undefined) {
    return jsonError("invalid_path", 400);
  }
  const paths = parsePhotoPathList(parsed.body.paths);
  if (!paths) {
    return jsonError("invalid_paths", 400);
  }
  return withPhotoErrors(async () => {
    const moved = await movePhotoEntries(context.db, context.accountId, paths, to);
    return NextResponse.json({ moved });
  });
}

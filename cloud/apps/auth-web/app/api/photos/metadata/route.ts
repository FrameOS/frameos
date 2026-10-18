import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { photoMetadata, removePhotoMetadata } from "../../../../src/lib/photos/library";
import { parsePhotoPath, parsePhotoPathList } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// Up to 10 000 paths of up to 1 KB each would not fit nginx's 10 MB; this
// leaves the path list's own limits to answer.
const maxBodyBytes = 8 * 1024 * 1024;

// GET /api/photos/metadata?path=<file> -> {"path", "metadata": Metadata}
// (docs/photos.md "Metadata"): the stored copy, or the object read (and the
// result stored) for a photo that has none yet. 400 for a bad path or a
// folder, 404 for nothing there.
export async function GET(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "read" });
  if (context.response) {
    return context.response;
  }
  const path = parsePhotoPath(request.nextUrl.searchParams.get("path") ?? "", { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  return withPhotoErrors(async () => {
    const metadata = await photoMetadata(context.db, context.accountId, path);
    return NextResponse.json({ metadata, path }, { headers: { "cache-control": "no-store" } });
  });
}

// POST /api/photos/metadata {"paths": [...], "remove": "location" | "all"}
// -> {"entries": [Entry, ...], "changed": n}. Takes the location, or every
// piece of metadata, out of each file (src/lib/photos/metadata.ts); every
// path is checked first, and one missing (404) or a folder (400) changes
// nothing.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const parsed = await readBoundedJsonObject(request, maxBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const paths = parsePhotoPathList(parsed.body.paths);
  if (!paths) {
    return jsonError("invalid_paths", 400);
  }
  const removal = parsed.body.remove;
  if (removal !== "location" && removal !== "all") {
    return jsonError("invalid_request", 400, { detail: 'remove must be "location" or "all"' });
  }
  return withPhotoErrors(async () => {
    const result = await removePhotoMetadata(context.db, context.accountId, paths, removal);
    return NextResponse.json(result);
  });
}

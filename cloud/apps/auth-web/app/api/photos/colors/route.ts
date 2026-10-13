import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { maxPhotoColorsBytes, parsePhotoColors } from "../../../../src/lib/photos/colors";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { setPhotoColors } from "../../../../src/lib/photos/library";
import { parsePhotoPath } from "../../../../src/lib/photos/paths";

export const runtime = "nodejs";

// The body is the profile plus a path: room for a 64 KB profile however the
// client spaced or escaped it, so the profile's own limit is what answers.
const maxBodyBytes = 4 * maxPhotoColorsBytes;

// POST /api/photos/colors {"path": "Summer 2026/a.jpg", "colors": {...}} ->
// {"entry": Entry}. Sets the photo's color profile; `null` or `{}` removes
// it (docs/photos.md "Colors"). 400 for a folder, a file a frame cannot play
// or a profile that is not a JSON object; 404 for nothing there; 413 for a
// profile over 64 KB as JSON.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "write" });
  if (context.response) {
    return context.response;
  }
  const parsed = await readBoundedJsonObject(request, maxBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const path = parsePhotoPath(parsed.body.path, { allowRoot: false });
  if (path === undefined) {
    return jsonError("invalid_path", 400);
  }
  const colors = parsePhotoColors(parsed.body.colors);
  if (colors.error) {
    return jsonError(
      colors.error,
      colors.status,
      colors.status === 413 ? { max_bytes: maxPhotoColorsBytes } : undefined,
    );
  }
  return withPhotoErrors(async () => {
    const entry = await setPhotoColors(context.db, context.accountId, path, colors.colors);
    return NextResponse.json({ entry });
  });
}

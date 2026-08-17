import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { catalogueFont } from "../../../../src/lib/fonts";

export const runtime = "nodejs";

// One font's bytes, at the path the shared SPA's fontsModel fetches
// (/api/fonts/<file>, which it turns into an @font-face rule).
//
// The bytes themselves live in public/fonts and are served by the static
// handler, so this only resolves the name and redirects — which keeps a 700 KB
// TTF off the Node process and lets the browser cache it under a stable URL.
// A name that is not in the catalogue is a 404 and never touches the
// filesystem, so there is no path traversal to defend against.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const font = catalogueFont(file);
  if (!font) {
    return jsonError("font_not_found", 404);
  }
  return NextResponse.redirect(new URL(`/fonts/${font.file}`, request.url), 307);
}

import { NextRequest } from "next/server";
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
  _request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const font = catalogueFont(file);
  if (!font) {
    return jsonError("font_not_found", 404);
  }
  // A RELATIVE Location, deliberately. NextResponse.redirect insists on an
  // absolute URL, and building one from request.url in production yields
  // https://localhost:3000/… — the origin the Node server sees behind nginx,
  // not the one the browser asked. Every font then 404s at an address only
  // the server can reach. A relative Location (RFC 7231 §7.1.2) is resolved
  // against the request URL by the client, which is exactly right.
  return new Response(null, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      Location: `/fonts/${font.file}`,
    },
    status: 307,
  });
}

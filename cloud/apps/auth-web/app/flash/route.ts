import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// The browser flasher (cloud/docs/flasher.md): flash.frameos.net's root
// (src/lib/surfaces.ts flasherRootRewrite), /flash on the cloud origin
// without FRAMEOS_FLASHER_APP_URL. The page is cloud-frontend's second entry
// (src/flasher), copied into public/frames-app with the frames SPA by
// scripts/copy-frames-app-assets.mjs; this route only answers with its shell.
// Nothing is injected: the page needs no account, no hub and no config, and
// it reaches only the same-origin firmware route (and, in a bridge job, the
// page that opened it).
export async function GET() {
  let html: string;
  try {
    html = await readFile(
      join(process.cwd(), "public", "frames-app", "flasher.html"),
      "utf8",
    );
  } catch {
    return new NextResponse(
      "The flasher is not built. Run `turbo run build --filter=@frameos/cloud-frontend` " +
        "and restart (scripts/copy-frames-app-assets.mjs copies it into public/frames-app).",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new NextResponse(html, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

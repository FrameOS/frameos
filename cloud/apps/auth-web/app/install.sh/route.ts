import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// The standalone frame installer (scripts/frameos-setup.sh, copied to
// public/install.template.sh by scripts/copy-install-script.mjs), served with
// THIS provider's origin stamped into it.
//
// Why a route and not a static file: the install command used to have to name
// the provider twice —
//   curl -fsSL {origin}/install.sh | sudo FRAMEOS_CLOUD_URL={origin} … sh
// — because a piped script cannot know where it was downloaded from. Stamping
// the origin here lets the command carry only the claim token, and removes a
// whole class of mistake where the two URLs disagree and the frame enrols
// against a different provider than the one that issued its token.
//
// The token stays an environment variable and never goes in the URL: query
// strings land in proxy logs, browser history and shell history.

const originAnchor = "# __FRAMEOS_CLOUD_URL_DEFAULT__";

export async function GET(request: NextRequest) {
  let script: string;
  try {
    script = await readFile(
      join(process.cwd(), "public", "install.template.sh"),
      "utf8",
    );
  } catch {
    return new NextResponse(
      "The FrameOS installer is not bundled with this deployment. Run " +
        "scripts/copy-install-script.mjs (it runs as part of the build).\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const line = script
    .split("\n")
    .find((candidate) => candidate.trimEnd().endsWith(originAnchor));
  if (!line) {
    // Serving it unstamped would silently default every frame installed from
    // this provider to cloud.frameos.net, which is exactly the mix-up the
    // stamping exists to prevent. Fail where someone will see it.
    return new NextResponse(
      `The installer has no ${originAnchor} marker, so this provider's URL ` +
        "cannot be stamped into it. Update scripts/frameos-setup.sh.\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // The frame will POST its enrollment here, so it must be the origin the user
  // actually reached us on — a LAN IP during development, the public hostname
  // in production — not a configured guess.
  const origin = new URL(request.url).origin;
  const stamped = script.replace(
    line,
    `FRAMEOS_CLOUD_URL_DEFAULT="${origin}" ${originAnchor}`,
  );

  return new NextResponse(stamped, {
    headers: {
      "cache-control": "no-store",
      // Deliberately not application/x-sh: browsers download that, and people
      // do open this URL to read the script before piping it to a shell.
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

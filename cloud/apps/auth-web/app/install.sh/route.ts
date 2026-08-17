import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getPublicOrigin } from "../../src/lib/env";

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
const releaseAnchor = "# __FRAMEOS_RELEASE_VERSION_DEFAULT__";

const releaseApiUrl =
  "https://api.github.com/repos/FrameOS/frameos/releases/latest";

// The newest published release, stamped into the script the same way the
// origin is. The script's own pin went stale once (it sat at 2026.6.8 while
// 2026.8.0 was out) and every install silently got a months-old build whose
// binary didn't even match the systemd unit the script writes. Best-effort:
// when GitHub is unreachable the script's pinned fallback still installs.
async function latestReleaseVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(releaseApiUrl, {
      headers: { accept: "application/vnd.github+json" },
      // Releases change rarely; caching keeps us far from GitHub's rate limit.
      next: { revalidate: 300 },
    });
    if (!response.ok) {
      return undefined;
    }
    const release = (await response.json()) as { tag_name?: string };
    const version = release.tag_name?.replace(/^v/, "");
    // The value lands inside a double-quoted shell assignment — accept only a
    // plain version so a hijacked API response cannot inject shell.
    return version && /^[0-9][0-9A-Za-z.-]*$/.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

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
  // in production.
  //
  // Not from request.url: behind nginx that is the address Next listens on, so
  // production served every installer with
  // FRAMEOS_CLOUD_URL_DEFAULT="https://localhost:3000" — a frame enrolling
  // against itself. getPublicOrigin reads the forwarded host and checks it
  // against the origins this deployment has configured, which also stops a
  // spoofed Host from writing a hostname into a command people pipe to a shell.
  const origin = getPublicOrigin(request);
  let stamped = script.replace(
    line,
    `FRAMEOS_CLOUD_URL_DEFAULT="${origin}" ${originAnchor}`,
  );

  const releaseLine = script
    .split("\n")
    .find((candidate) => candidate.trimEnd().endsWith(releaseAnchor));
  if (!releaseLine) {
    return new NextResponse(
      `The installer has no ${releaseAnchor} marker, so the current release ` +
        "version cannot be stamped into it. Update scripts/frameos-setup.sh.\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const version = await latestReleaseVersion();
  if (version) {
    stamped = stamped.replace(
      releaseLine,
      `FRAMEOS_RELEASE_VERSION_DEFAULT="${version}" ${releaseAnchor}`,
    );
  }

  return new NextResponse(stamped, {
    headers: {
      "cache-control": "no-store",
      // Deliberately not application/x-sh: browsers download that, and people
      // do open this URL to read the script before piping it to a shell.
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

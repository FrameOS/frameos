import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The install command used to name the provider twice — once in the curl URL
// and once in FRAMEOS_CLOUD_URL — because a piped script cannot know where it
// came from. The route stamps it in, so the two can never disagree.
const anchor = "# __FRAMEOS_CLOUD_URL_DEFAULT__";
// Same trick for the release: the script's pinned version went stale once and
// installs silently got a months-old build, so the route stamps the newest
// published release in at request time.
const releaseAnchor = "# __FRAMEOS_RELEASE_VERSION_DEFAULT__";

function templateScript() {
  return [
    "#!/bin/sh",
    `FRAMEOS_RELEASE_VERSION_DEFAULT="2026.8.0" ${releaseAnchor}`,
    'FRAMEOS_RELEASE_VERSION="${FRAMEOS_RELEASE_VERSION:-$FRAMEOS_RELEASE_VERSION_DEFAULT}"',
    `FRAMEOS_CLOUD_URL_DEFAULT="https://cloud.frameos.net" ${anchor}`,
    'FRAMEOS_CLOUD_URL="${FRAMEOS_CLOUD_URL:-$FRAMEOS_CLOUD_URL_DEFAULT}"',
  ].join("\n");
}

let scriptOnDisk = templateScript();
let readFails = false;

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    if (readFails) {
      throw new Error("ENOENT");
    }
    return scriptOnDisk;
  }),
}));

const { GET } = await import("./route");

function get(url: string) {
  return GET(new NextRequest(new Request(url)));
}

const fetchMock = vi.fn<typeof fetch>();

describe("GET /install.sh", () => {
  beforeEach(() => {
    readFails = false;
    scriptOnDisk = templateScript();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      Response.json({ tag_name: "v2026.9.1" }) as never,
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stamps the origin the frame was actually pointed at", async () => {
    // A LAN address in development is the case that matters: this is where the
    // frame will POST its enrollment.
    const response = await get("http://10.4.0.47:3000/install.sh");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(
      `FRAMEOS_CLOUD_URL_DEFAULT="http://10.4.0.47:3000" ${anchor}`,
    );
    expect(body).not.toContain("cloud.frameos.net");
  });

  it("stamps the newest published release version", async () => {
    const response = await get("https://cloud.frameos.net/install.sh");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(
      `FRAMEOS_RELEASE_VERSION_DEFAULT="2026.9.1" ${releaseAnchor}`,
    );
  });

  it("keeps the script's pinned release when GitHub is unreachable", async () => {
    // Best-effort on purpose: a stale-but-working install beats a 503.
    fetchMock.mockResolvedValue(
      Response.json({ message: "rate limited" }, { status: 403 }) as never,
    );
    const response = await get("https://cloud.frameos.net/install.sh");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(
      `FRAMEOS_RELEASE_VERSION_DEFAULT="2026.8.0" ${releaseAnchor}`,
    );
  });

  it("never stamps a release tag that could break out of the shell quoting", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ tag_name: 'v2026"; rm -rf / #' }) as never,
    );
    const response = await get("https://cloud.frameos.net/install.sh");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(
      `FRAMEOS_RELEASE_VERSION_DEFAULT="2026.8.0" ${releaseAnchor}`,
    );
    expect(body).not.toContain("rm -rf");
  });

  it("keeps the script readable in a browser rather than downloading it", async () => {
    const response = await get("https://cloud.frameos.net/install.sh");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses to serve an installer it could not stamp", async () => {
    // Serving it unstamped would quietly default every frame to
    // cloud.frameos.net — the exact mix-up this route exists to prevent.
    scriptOnDisk = '#!/bin/sh\nFRAMEOS_CLOUD_URL_DEFAULT="https://cloud.frameos.net"';
    const response = await get("https://self.hosted.example/install.sh");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(anchor);
  });

  it("refuses to serve an installer without the release marker", async () => {
    scriptOnDisk = [
      "#!/bin/sh",
      `FRAMEOS_CLOUD_URL_DEFAULT="https://cloud.frameos.net" ${anchor}`,
    ].join("\n");
    const response = await get("https://cloud.frameos.net/install.sh");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(releaseAnchor);
  });

  it("says so when the installer is missing from the deployment", async () => {
    readFails = true;
    const response = await get("https://cloud.frameos.net/install.sh");
    expect(response.status).toBe(503);
  });
});

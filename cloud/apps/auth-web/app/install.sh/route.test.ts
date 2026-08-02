import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The install command used to name the provider twice — once in the curl URL
// and once in FRAMEOS_CLOUD_URL — because a piped script cannot know where it
// came from. The route stamps it in, so the two can never disagree.
const anchor = "# __FRAMEOS_CLOUD_URL_DEFAULT__";
let scriptOnDisk = [
  "#!/bin/sh",
  `FRAMEOS_CLOUD_URL_DEFAULT="https://cloud.frameos.net" ${anchor}`,
  'FRAMEOS_CLOUD_URL="${FRAMEOS_CLOUD_URL:-$FRAMEOS_CLOUD_URL_DEFAULT}"',
].join("\n");
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

describe("GET /install.sh", () => {
  beforeEach(() => {
    readFails = false;
    scriptOnDisk = [
      "#!/bin/sh",
      `FRAMEOS_CLOUD_URL_DEFAULT="https://cloud.frameos.net" ${anchor}`,
      'FRAMEOS_CLOUD_URL="${FRAMEOS_CLOUD_URL:-$FRAMEOS_CLOUD_URL_DEFAULT}"',
    ].join("\n");
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

  it("says so when the installer is missing from the deployment", async () => {
    readFails = true;
    const response = await get("https://cloud.frameos.net/install.sh");
    expect(response.status).toBe(503);
  });
});

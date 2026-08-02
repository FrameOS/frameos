import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The fleet SPA learns where its WebSocket lives from cloud_ws_origin in the
// shell. Get it wrong and the SPA dials the Next server itself, which has no
// WebSocket handler: a 1006 reconnect loop with no useful error.
// The real shell documents the anchor in a comment ABOVE the config object,
// so the token appears twice. A substring replace rewrites the comment and
// leaves the actual line alone — which is precisely how this shipped broken:
// the socket kept pointing at the Next server and looped on 1006.
const shell = [
  "<html><head><script>",
  "// NOTE: the //__FRAMEOS_CLOUD_WS_ORIGIN__ line below is a named anchor.",
  "window.FRAMEOS_APP_CONFIG = {",
  "  cloudMode: true,",
  "  //__FRAMEOS_CLOUD_WS_ORIGIN__",
  "  ingress_path: '',",
  "}",
  "</script></head><body></body></html>",
].join("\n");

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => shell),
}));

const { GET } = await import("./route");

function get(url: string) {
  return GET(new NextRequest(new Request(url)));
}

describe("frames SPA shell", () => {
  beforeEach(() => {
    delete process.env.FRAME_HUB_PUBLIC_URL;
  });

  it("points a localhost request at the dev hub's own port", async () => {
    const body = await (await get("http://localhost:3000/frames")).text();
    expect(body).toContain('cloud_ws_origin: "http://localhost:3100"');
  });

  it("injects into the config line, not the comment that names the anchor", async () => {
    const body = await (await get("http://localhost:3000/frames")).text();
    const lines = body.split("\n");

    // The config object got the origin...
    expect(
      lines.some(
        (line) => line.trim() === 'cloud_ws_origin: "http://localhost:3100",',
      ),
    ).toBe(true);
    // ...and the comment above it is still a comment, not a mangled sentence
    // with a config line spliced into the middle of it.
    expect(body).toContain(
      "// NOTE: the //__FRAMEOS_CLOUD_WS_ORIGIN__ line below is a named anchor.",
    );
    // Exactly one injection: no leftover anchor line pretending to be config.
    expect(
      lines.filter((line) => line.trim() === "//__FRAMEOS_CLOUD_WS_ORIGIN__"),
    ).toHaveLength(0);
  });

  it("leaves a real hostname same-origin, where nginx proxies the socket", async () => {
    const body = await (
      await get("https://account.frameos.net/frames")
    ).text();
    // No override: the SPA falls back to its own origin, which is correct
    // behind the production reverse proxy.
    expect(body).not.toContain("cloud_ws_origin");
    expect(body).toContain("__FRAMEOS_CLOUD_WS_ORIGIN__");
  });

  it("uses an explicit FRAME_HUB_PUBLIC_URL anywhere, trailing slash and all", async () => {
    process.env.FRAME_HUB_PUBLIC_URL = "https://hub.frameos.net/";
    const body = await (
      await get("https://account.frameos.net/frames")
    ).text();
    expect(body).toContain('cloud_ws_origin: "https://hub.frameos.net"');
  });

  it("treats an empty FRAME_HUB_PUBLIC_URL as unset, not as an origin", async () => {
    // `?? ` keeps "" — the same trap FRAME_HUB_PORT= documents — which would
    // silently disable the injection on a machine with the var declared blank.
    process.env.FRAME_HUB_PUBLIC_URL = "  ";
    const body = await (await get("http://localhost:3000/frames")).text();
    expect(body).toContain('cloud_ws_origin: "http://localhost:3100"');
  });
});

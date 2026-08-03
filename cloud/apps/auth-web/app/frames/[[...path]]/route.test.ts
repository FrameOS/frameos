import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The fleet SPA learns two things from the shell it is served in: where its
// WebSocket lives (cloud_ws_origin) and where the account surfaces live
// (cloud_account_url and friends). Get the first wrong and the SPA dials the
// Next server itself, which has no WebSocket handler: a 1006 reconnect loop
// with no useful error. Get the second wrong and the account header links to
// the wrong origin — and the enrollment origin baked into SD images and ESP32
// NVS points at whatever host the admin happened to browse through.
// The real shell documents both anchors in a comment ABOVE the config object,
// so each token appears twice. A substring replace rewrites the comment and
// leaves the actual line alone — which is precisely how this shipped broken:
// the socket kept pointing at the Next server and looped on 1006.
const shell = [
  "<html><head><script>",
  "// NOTE: the //__FRAMEOS_CLOUD_WS_ORIGIN__ and //__FRAMEOS_CLOUD_APP_CONFIG__ lines below are named anchors.",
  "window.FRAMEOS_APP_CONFIG = {",
  "  cloudMode: true,",
  "  //__FRAMEOS_CLOUD_WS_ORIGIN__",
  "  //__FRAMEOS_CLOUD_APP_CONFIG__",
  "  ingress_path: '',",
  "}",
  "</script></head><body></body></html>",
].join("\n");

const readFile = vi.hoisted(() => vi.fn(async () => shell));

vi.mock("node:fs/promises", () => ({ readFile }));

const { GET } = await import("./route");

function get(url: string) {
  return GET(new NextRequest(new Request(url)));
}

describe("frames SPA shell", () => {
  beforeEach(() => {
    delete process.env.FRAME_HUB_PUBLIC_URL;
    delete process.env.FRAMEOS_ACCOUNT_APP_URL;
    delete process.env.FRAMEOS_SCENES_APP_URL;
    delete process.env.FRAMEOS_CLOUD_APP_URL;
    readFile.mockResolvedValue(shell);
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
      "// NOTE: the //__FRAMEOS_CLOUD_WS_ORIGIN__ and //__FRAMEOS_CLOUD_APP_CONFIG__ lines below are named anchors.",
    );
    // Exactly one injection each: no leftover anchor line pretending to be
    // config.
    expect(
      lines.filter((line) => line.trim() === "//__FRAMEOS_CLOUD_WS_ORIGIN__"),
    ).toHaveLength(0);
    expect(
      lines.filter((line) => line.trim() === "//__FRAMEOS_CLOUD_APP_CONFIG__"),
    ).toHaveLength(0);
  });

  it("points a LAN-IP request at the dev hub on the same host", async () => {
    // Browsing `pnpm dev` from another device on the network: the shell must
    // send the socket to this machine's LAN address (localhost would resolve
    // to the phone itself), on the hub's own port. The hub side accepts the
    // private-network Origin outside production — frame-hub env.ts
    // allowsPrivateNetworkOrigins — and the dev session cookie is host-only
    // for the LAN IP, so it reaches port 3100 too (cookies ignore ports).
    const body = await (await get("http://10.4.0.47:3000/frames")).text();
    expect(body).toContain('cloud_ws_origin: "http://10.4.0.47:3100"');
  });

  it("does not treat a public IP or private-prefixed hostname as a LAN dev server", async () => {
    for (const origin of [
      "http://203.0.113.5:3000",
      "http://10.4.evil.example:3000",
    ]) {
      const body = await (await get(`${origin}/frames`)).text();
      expect(body).not.toContain("cloud_ws_origin");
    }
  });

  it("prefers an explicit FRAME_HUB_PUBLIC_URL over the LAN-IP guess", async () => {
    process.env.FRAME_HUB_PUBLIC_URL = "https://hub.frameos.net";
    const body = await (await get("http://10.4.0.47:3000/frames")).text();
    expect(body).toContain('cloud_ws_origin: "https://hub.frameos.net"');
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

  // The account header (Scenes / Frames / Account / Sign out) and the
  // enrollment origin are server-side facts; a client-only bundle cannot
  // derive them from window.location.
  it("injects the account surfaces, on one origin or three", async () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    const lines = (await (await get("https://account.frameos.net/frames")).text())
      .split("\n")
      .map((line) => line.trim());

    expect(lines).toContain('cloud_scenes_url: "https://scenes.frameos.net/",');
    expect(lines).toContain(
      'cloud_frames_url: "https://account.frameos.net/frames",',
    );
    // Sign out is served by the auth origin, not the account one.
    expect(lines).toContain(
      'cloud_logout_url: "https://frameos.net/api/auth/logout",',
    );
    // On a split-host deployment "/account" shortens to "/backends" — the
    // SPA cannot know that rule, so the server sends the finished URL.
    expect(lines).toContain(
      'cloud_account_url: "https://account.frameos.net/backends",',
    );
    // Baked into SD images and ESP32 NVS: the deployment's public URL, never
    // the browser's address bar.
    expect(lines).toContain('cloud_origin: "https://account.frameos.net",');
  });

  it("substitutes the machine's LAN address for a localhost enrollment origin", async () => {
    // A frame flashed against `pnpm dev` receives cloud_url over serial; if
    // that is http://localhost:3000 the device dials itself and never
    // enrolls. The header links keep localhost (the browser is local), but
    // the enrollment origin swaps in this machine's LAN IPv4.
    const body = await (await get("http://localhost:3000/frames")).text();
    const match = body.match(/cloud_origin: "(.*)",/);
    expect(match).not.toBeNull();
    const origin = new URL(match![1]!);
    // Whatever interface the test machine has: an IPv4 that is not loopback,
    // or (on a machine with no network at all) localhost as the fallback.
    expect(origin.port).toBe("3000");
    if (origin.hostname !== "localhost") {
      expect(origin.hostname).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(origin.hostname).not.toBe("127.0.0.1");
    }
  });

  it("sends the deployment's claim-code TTL rather than a hardcoded 24h", async () => {
    const body = await (await get("http://localhost:3000/frames")).text();
    // The default; FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS is read at module load
    // in src/lib/frames.ts, so this pins the wiring, not the number.
    expect(body).toContain("cloud_claim_token_ttl_hours: 24,");
  });

  it("refuses to serve a shell that lost the app-config anchor", async () => {
    readFile.mockResolvedValue(
      shell
        .split("\n")
        .filter((line) => line.trim() !== "//__FRAMEOS_CLOUD_APP_CONFIG__")
        .join("\n"),
    );
    const response = await get("https://account.frameos.net/frames");
    // Silently serving it would give every account header links to the wrong
    // origin and an add-frame panel writing the wrong URL into SD images.
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Rebuild cloud-frontend");
  });
});

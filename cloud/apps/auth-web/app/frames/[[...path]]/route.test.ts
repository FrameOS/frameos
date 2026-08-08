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

// The enrollment origin's LAN-address lookup asks the routing table (a UDP
// connect) and falls back to scanning interfaces. Both are machine state, so
// both are fixtures here — the real bug this guards against (bridge100
// beating en0 by enumeration order) only reproduces on a machine running
// Internet Sharing.
const lanFixtures = vi.hoisted(() => ({
  defaultRouteAddress: undefined as string | undefined,
  interfaces: {} as Record<
    string,
    { address: string; family: string; internal: boolean }[]
  >,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, networkInterfaces: () => lanFixtures.interfaces };
});

vi.mock("node:dgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dgram")>();
  return {
    ...actual,
    createSocket: () => {
      const errorListeners: (() => void)[] = [];
      return {
        once(event: string, listener: () => void) {
          if (event === "error") errorListeners.push(listener);
        },
        connect(_port: number, _host: string, connected: () => void) {
          if (lanFixtures.defaultRouteAddress === undefined) {
            queueMicrotask(() => errorListeners.forEach((l) => l()));
          } else {
            connected();
          }
        },
        address() {
          return {
            address: lanFixtures.defaultRouteAddress,
            family: "IPv4",
            port: 0,
          };
        },
        close() {},
      };
    },
  };
});

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
    lanFixtures.defaultRouteAddress = "10.4.0.47";
    lanFixtures.interfaces = {
      en0: [{ address: "10.4.0.47", family: "IPv4", internal: false }],
    };
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

  it("re-homes a cross-host LOCAL hub override onto the page's own hostname", async () => {
    // FRAME_HUB_PUBLIC_URL=http://<lan-ip>:3100 exists for the DEVICE (it
    // must dial the LAN address). A browser on http://localhost:3000 must
    // not inherit it: the dev session cookie is host-only for localhost, so
    // a socket to the LAN IP never carries it and the hub 401s every
    // upgrade — the fleet socket then error-loops. The browser keeps the
    // page's hostname (cookies ignore ports); the LAN-IP page keeps the
    // LAN-IP hub.
    process.env.FRAME_HUB_PUBLIC_URL = "http://10.4.0.47:3100";
    const local = await (await get("http://localhost:3000/frames")).text();
    expect(local).toContain('cloud_ws_origin: "http://localhost:3100"');
    const lan = await (await get("http://10.4.0.47:3000/frames")).text();
    expect(lan).toContain('cloud_ws_origin: "http://10.4.0.47:3100"');
  });

  it("never guesses a hub origin in production, even for localhost requests", async () => {
    // The standalone server does not rebuild request.url from the forwarded
    // Host header, so behind nginx every production request looks like
    // localhost — the guess shipped ws://localhost:3100 to real browsers.
    // Only an explicit FRAME_HUB_PUBLIC_URL may point elsewhere in prod.
    vi.stubEnv("NODE_ENV", "production");
    try {
      for (const origin of ["http://localhost:3000", "http://10.4.0.47:3000"]) {
        const body = await (await get(`${origin}/frames`)).text();
        expect(body).not.toContain("cloud_ws_origin");
      }
      process.env.FRAME_HUB_PUBLIC_URL = "https://hub.frameos.net";
      const body = await (await get("http://localhost:3000/frames")).text();
      expect(body).toContain('cloud_ws_origin: "https://hub.frameos.net"');
    } finally {
      vi.unstubAllEnvs();
    }
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
    expect(body).toContain('cloud_origin: "http://10.4.0.47:3000",');
  });

  it("takes the default route's address, not the first RFC1918 interface", async () => {
    // macOS Internet Sharing's bridge100 holds 192.168.139.x — RFC1918, but
    // host-only. It enumerates before en0, and picking it provisioned frames
    // with a cloud_url they could never reach ("provider unreachable").
    lanFixtures.defaultRouteAddress = "10.4.0.47";
    lanFixtures.interfaces = {
      bridge100: [
        { address: "192.168.139.3", family: "IPv4", internal: false },
      ],
      en0: [{ address: "10.4.0.47", family: "IPv4", internal: false }],
    };
    const body = await (await get("http://localhost:3000/frames")).text();
    expect(body).toContain('cloud_origin: "http://10.4.0.47:3000",');
  });

  it("skips virtual bridges when the default route is a VPN", async () => {
    // Full-tunnel VPN: the default route's source address is not RFC1918, so
    // the interface scan decides — and must still prefer the physical NIC
    // over an Internet Sharing bridge listed first.
    lanFixtures.defaultRouteAddress = "100.98.45.113";
    lanFixtures.interfaces = {
      bridge100: [
        { address: "192.168.139.3", family: "IPv4", internal: false },
      ],
      en0: [{ address: "10.4.0.47", family: "IPv4", internal: false }],
    };
    const body = await (await get("http://localhost:3000/frames")).text();
    expect(body).toContain('cloud_origin: "http://10.4.0.47:3000",');
  });

  it("keeps localhost when the machine has no usable network", async () => {
    lanFixtures.defaultRouteAddress = undefined;
    lanFixtures.interfaces = {};
    const body = await (await get("http://localhost:3000/frames")).text();
    expect(body).toContain('cloud_origin: "http://localhost:3000",');
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

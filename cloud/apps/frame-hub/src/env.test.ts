import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowsPrivateNetworkOrigins,
  getAllowedBrowserOrigins,
  getHubPort,
  getMaxConnections,
  isAllowedBrowserOrigin,
  isPrivateNetworkHostname,
  loadLocalEnv,
} from "./env";

// Every test mutates process.env; snapshot and restore the keys it touches so
// the suite stays order-independent.
const touchedKeys = [
  "NODE_ENV",
  "FRAMEOS_ACCOUNT_APP_URL",
  "FRAMEOS_CLOUD_APP_URL",
  "FRAMEOS_SCENES_APP_URL",
  "FRAME_HUB_ALLOWED_ORIGINS",
  "FRAME_HUB_MAX_CONNECTIONS",
  "FRAME_HUB_PORT",
  "HUB_TEST_ALREADY_SET",
  "HUB_TEST_QUOTED",
  "HUB_TEST_VALUE",
];
const original = new Map(touchedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("loadLocalEnv", () => {
  it("applies the nearest .env.local, walking up from the start directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "frame-hub-env-"));
    const nested = path.join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(root, ".env.local"),
      [
        "# a comment",
        "",
        "HUB_TEST_VALUE=from-file",
        'HUB_TEST_QUOTED = "spaced value" ',
        "HUB_TEST_ALREADY_SET=from-file",
        "not a variable line",
      ].join("\n"),
    );
    process.env.HUB_TEST_ALREADY_SET = "from-environment";

    expect(loadLocalEnv(nested)).toBe(path.join(root, ".env.local"));
    expect(process.env.HUB_TEST_VALUE).toBe("from-file");
    expect(process.env.HUB_TEST_QUOTED).toBe("spaced value");
    // Values already in the environment win: production supplies env through
    // the systemd unit and must never be overridden by a stray file.
    expect(process.env.HUB_TEST_ALREADY_SET).toBe("from-environment");
  });

  it("returns undefined when no .env.local is within reach", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "frame-hub-env-empty-"));
    const deep = path.join(empty, "a", "b", "c", "d", "e", "f");
    mkdirSync(deep, { recursive: true });
    expect(loadLocalEnv(deep)).toBeUndefined();
  });
});

describe("getHubPort", () => {
  it("defaults to 3100 and rejects nonsense", () => {
    delete process.env.FRAME_HUB_PORT;
    expect(getHubPort()).toBe(3100);
    for (const bad of ["", "http", "-1", "70000", "3100.5"]) {
      process.env.FRAME_HUB_PORT = bad;
      expect(getHubPort()).toBe(3100);
    }
  });

  it("accepts a valid port, including 0 for an ephemeral one", () => {
    process.env.FRAME_HUB_PORT = "3100";
    expect(getHubPort()).toBe(3100);
    process.env.FRAME_HUB_PORT = "0";
    expect(getHubPort()).toBe(0);
  });
});

describe("getMaxConnections", () => {
  it("defaults to 5000 and rejects non-positive or fractional values", () => {
    delete process.env.FRAME_HUB_MAX_CONNECTIONS;
    expect(getMaxConnections()).toBe(5000);
    for (const bad of ["0", "-5", "1.5", "lots"]) {
      process.env.FRAME_HUB_MAX_CONNECTIONS = bad;
      expect(getMaxConnections()).toBe(5000);
    }
    process.env.FRAME_HUB_MAX_CONNECTIONS = "12";
    expect(getMaxConnections()).toBe(12);
  });
});

describe("getAllowedBrowserOrigins", () => {
  it("derives the FrameOS app origins auth-web mints its cookie for", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    delete process.env.FRAME_HUB_ALLOWED_ORIGINS;
    expect([...getAllowedBrowserOrigins()].sort()).toEqual([
      "https://account.frameos.net",
      "https://cloud.frameos.net",
      "https://scenes.frameos.net",
    ]);
  });

  it("adds FRAME_HUB_ALLOWED_ORIGINS entries, normalized to origins", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    delete process.env.FRAMEOS_ACCOUNT_APP_URL;
    delete process.env.FRAMEOS_SCENES_APP_URL;
    process.env.FRAME_HUB_ALLOWED_ORIGINS =
      " https://extra.example/path , , https://other.example ";
    expect([...getAllowedBrowserOrigins()].sort()).toEqual([
      "http://localhost:3000",
      "https://extra.example",
      "https://other.example",
    ]);
  });
});

describe("isAllowedBrowserOrigin", () => {
  const allowed = new Set(["https://cloud.frameos.net"]);

  it("allows requests with no Origin header (never a browser)", () => {
    expect(isAllowedBrowserOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedBrowserOrigin("", allowed)).toBe(true);
  });

  it("allows a listed origin regardless of path or trailing slash", () => {
    expect(isAllowedBrowserOrigin("https://cloud.frameos.net", allowed)).toBe(
      true,
    );
    expect(isAllowedBrowserOrigin("https://cloud.frameos.net/", allowed)).toBe(
      true,
    );
  });

  it("rejects other origins, opaque origins, and junk", () => {
    expect(isAllowedBrowserOrigin("https://evil.example", allowed)).toBe(false);
    expect(isAllowedBrowserOrigin("http://cloud.frameos.net", allowed)).toBe(
      false,
    );
    expect(isAllowedBrowserOrigin("null", allowed)).toBe(false);
    expect(isAllowedBrowserOrigin("not-a-url", allowed)).toBe(false);
  });

  // The dev loosening: `pnpm dev` browsed via the machine's LAN IP presents
  // Origin http://<lan-ip>:3000, which no FRAMEOS_*_APP_URL ever names. With
  // allowPrivateNetwork the hub accepts loopback/private-network hosts —
  // gaps-doc item 7, the fleet socket from a LAN-IP workspace.
  it("accepts private-network origins only when allowPrivateNetwork is set", () => {
    for (const origin of [
      "http://10.4.0.47:3000",
      "http://192.168.1.5:3000",
      "http://172.16.0.9:3000",
      "http://172.31.255.1",
      "http://169.254.10.20:3000",
      "http://127.0.0.1:8080",
      "http://localhost:5173",
      "https://192.168.0.2",
    ]) {
      expect(isAllowedBrowserOrigin(origin, allowed, true)).toBe(true);
      // Without the flag (production) nothing changes.
      expect(isAllowedBrowserOrigin(origin, allowed)).toBe(false);
    }
  });

  it("never treats public or malformed hosts as private, flag or no flag", () => {
    for (const origin of [
      "https://evil.example",
      "http://11.0.0.1:3000", // just outside 10/8
      "http://172.32.0.1:3000", // just outside 172.16/12
      "http://192.169.0.1:3000", // just outside 192.168/16
      "http://10.4.evil.example:3000", // private-looking prefix, public name
      "null",
      "not-a-url",
    ]) {
      expect(isAllowedBrowserOrigin(origin, allowed, true)).toBe(false);
    }
    // The allowlist itself still works with the flag on.
    expect(
      isAllowedBrowserOrigin("https://cloud.frameos.net", allowed, true),
    ).toBe(true);
  });
});

describe("isPrivateNetworkHostname", () => {
  it("requires complete in-range IPv4 literals (or localhost)", () => {
    expect(isPrivateNetworkHostname("localhost")).toBe(true);
    expect(isPrivateNetworkHostname("[::1]")).toBe(true);
    expect(isPrivateNetworkHostname("10.0.0.1")).toBe(true);
    expect(isPrivateNetworkHostname("10.4")).toBe(false);
    expect(isPrivateNetworkHostname("10.0.0.999")).toBe(false);
    expect(isPrivateNetworkHostname("frameos.net")).toBe(false);
    expect(isPrivateNetworkHostname("sub.localhost")).toBe(false);
  });
});

describe("allowsPrivateNetworkOrigins", () => {
  it("is on for anything but production", () => {
    process.env.NODE_ENV = "development";
    expect(allowsPrivateNetworkOrigins()).toBe(true);
    delete process.env.NODE_ENV;
    expect(allowsPrivateNetworkOrigins()).toBe(true);
  });

  it("is off in production — deployment.md's frame-hub.env sets NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    expect(allowsPrivateNetworkOrigins()).toBe(false);
  });
});

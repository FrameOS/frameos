import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAllowedBrowserOrigins,
  getHubPort,
  getMaxConnections,
  isAllowedBrowserOrigin,
  loadLocalEnv,
} from "./env";

// Every test mutates process.env; snapshot and restore the keys it touches so
// the suite stays order-independent.
const touchedKeys = [
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
});

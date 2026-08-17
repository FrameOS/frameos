import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPublicOrigin } from "./env";

// Production shipped an installer that told every frame to enrol against
// https://localhost:3000, and a frame-login redirect that sent people to the
// same place. Both built a URL from `request.url`, which behind nginx is the
// address Next is listening on — not the address anyone typed.
//
// The Host header is what carries the truth there. Trusting it blindly is the
// other failure: /install.sh is piped straight to a shell, so a hostname
// someone else chose must never end up in it.

const environment = {
  cloud: process.env.FRAMEOS_CLOUD_APP_URL,
  scenes: process.env.FRAMEOS_SCENES_APP_URL,
};

function request(url: string, headers: Record<string, string> = {}) {
  return { headers: new Headers(headers), url };
}

beforeEach(() => {
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
});

afterEach(() => {
  for (const [key, value] of [
    ["FRAMEOS_CLOUD_APP_URL", environment.cloud],
    ["FRAMEOS_SCENES_APP_URL", environment.scenes],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("getPublicOrigin", () => {
  it("uses the hostname the browser asked for, not the port Next listens on", () => {
    // Exactly the production shape: nginx forwards Host, Next still reports
    // its own socket in request.url.
    expect(
      getPublicOrigin(
        request("https://localhost:3000/install.sh", {
          host: "cloud.frameos.net",
        }),
      ),
    ).toBe("https://cloud.frameos.net");
  });

  it("keeps each configured surface on its own origin", () => {
    expect(
      getPublicOrigin(
        request("https://localhost:3000/scenes", { host: "scenes.frameos.net" }),
      ),
    ).toBe("https://scenes.frameos.net");
  });

  it("reads x-forwarded-host ahead of host, and ignores the rest of the chain", () => {
    expect(
      getPublicOrigin(
        request("https://localhost:3000/install.sh", {
          host: "127.0.0.1:3000",
          "x-forwarded-host": "cloud.frameos.net, inner-proxy.local",
        }),
      ),
    ).toBe("https://cloud.frameos.net");
  });

  it("refuses a Host nobody configured, rather than stamping it into a script", () => {
    // The whole reason this is not just `headers.get("host")`: the result is
    // interpolated into a shell command people pipe to root.
    expect(
      getPublicOrigin(
        request("https://localhost:3000/install.sh", { host: "evil.example" }),
      ),
    ).toBe("https://cloud.frameos.net");
  });

  it("serves a LAN address in development, where nothing proxies", () => {
    // A frame enrolling against a laptop needs the address the laptop was
    // reached on — and with no proxy, request.url is exactly that.
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    delete process.env.FRAMEOS_SCENES_APP_URL;
    expect(getPublicOrigin(request("http://10.4.0.47:3000/install.sh"))).toBe(
      "http://10.4.0.47:3000",
    );
    expect(
      getPublicOrigin(
        request("http://10.4.0.47:3000/install.sh", { host: "10.4.0.47:3000" }),
      ),
    ).toBe("http://10.4.0.47:3000");
  });

  it("falls back to the cloud origin when the URL is unusable", () => {
    expect(getPublicOrigin({ headers: new Headers(), url: "not a url" })).toBe(
      "https://cloud.frameos.net",
    );
  });

  it("matches hostnames case-insensitively", () => {
    expect(
      getPublicOrigin(
        request("https://localhost:3000/install.sh", {
          host: "Cloud.FrameOS.net",
        }),
      ),
    ).toBe("https://cloud.frameos.net");
  });
});

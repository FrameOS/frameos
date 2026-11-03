// @vitest-environment jsdom
// The address a new frame is prefilled with for reaching the backend
// (frontend/src/utils/backendAddress.ts): Settings → Defaults first, else
// the backend this browser is on — and, on a Home Assistant add-on whose
// frames port serves TLS (the add-on's ssl option, docker-entrypoint.sh),
// `https://` in front, because the frame would otherwise speak plain HTTP to
// a TLS port and never report.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameOSSettings } from "../../../../../../frontend/src/types";
import {
  defaultNewFrameServerHost,
  detectedBackendAddressParts,
  splitServerAddress,
} from "../../../../../../frontend/src/utils/backendAddress";

// The SPA's runner of docs/server-address-fixtures.json: a typed backend
// address means the same thing here, on the backend
// (app/utils/tests/test_server_address.py) and on the frame
// (frameos/src/frameos/tests/test_server_address.nim).
const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../../../docs/server-address-fixtures.json"),
    "utf8",
  ),
) as {
  splitAddress: { cases: { input: string; scheme: string; host: string; port: number | null }[] };
};

describe("splitServerAddress", () => {
  for (const c of fixtures.splitAddress.cases) {
    it(`reads ${JSON.stringify(c.input)} as the other planes do`, () => {
      expect(splitServerAddress(c.input)).toEqual({
        scheme: c.scheme,
        host: c.host,
        port: c.port === null ? "" : String(c.port),
      });
    });
  }
});

type AppConfigWindow = { FRAMEOS_APP_CONFIG?: Record<string, unknown> };

function browserAt(href: string, appConfig?: Record<string, unknown>): void {
  const url = new URL(href);
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    href,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
  } as unknown as Location);
  if (appConfig) {
    (window as unknown as AppConfigWindow).FRAMEOS_APP_CONFIG = appConfig;
  } else {
    delete (window as unknown as AppConfigWindow).FRAMEOS_APP_CONFIG;
  }
}

function settings(defaults: Record<string, unknown>): FrameOSSettings {
  return { defaults } as unknown as FrameOSSettings;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as AppConfigWindow).FRAMEOS_APP_CONFIG;
});

describe("defaultNewFrameServerHost", () => {
  it("is the backend this browser is on, http left implicit", () => {
    browserAt("http://192.168.1.10:8989/frames");
    expect(detectedBackendAddressParts()).toEqual({ scheme: "http", host: "192.168.1.10", port: "8989" });
    expect(defaultNewFrameServerHost()).toBe("192.168.1.10:8989");
    expect(defaultNewFrameServerHost(settings({}))).toBe("192.168.1.10:8989");
  });

  it("says https when the browser reached the backend over TLS", () => {
    browserAt("https://frames.example.com/");
    expect(detectedBackendAddressParts()).toEqual({ scheme: "https", host: "frames.example.com", port: "443" });
    expect(defaultNewFrameServerHost()).toBe("https://frames.example.com:443");
    browserAt("https://frames.example.com:8443/");
    expect(defaultNewFrameServerHost()).toBe("https://frames.example.com:8443");
  });

  it("on the add-on, is port 8989 on the Home Assistant host, http unless the add-on's port serves TLS", () => {
    // The browser is on the Supervisor's ingress proxy; frames are not.
    browserAt("https://homeassistant.local:8123/api/hassio_ingress/abc/", { HASSIO_RUN_MODE: "ingress" });
    expect(defaultNewFrameServerHost()).toBe("homeassistant.local:8989");

    browserAt("https://homeassistant.local:8123/api/hassio_ingress/abc/", {
      HASSIO_RUN_MODE: "ingress",
      public_scheme: "https",
    });
    expect(detectedBackendAddressParts()).toEqual({ scheme: "https", host: "homeassistant.local", port: "8989" });
    expect(defaultNewFrameServerHost()).toBe("https://homeassistant.local:8989");
  });

  it("takes the configured default host, with the scheme it was given", () => {
    browserAt("http://192.168.1.10:8989/");
    expect(defaultNewFrameServerHost(settings({ backendHost: "frames.lan" }))).toBe("frames.lan:8989");
    expect(defaultNewFrameServerHost(settings({ backendHost: "frames.lan:9000" }))).toBe("frames.lan:9000");
    expect(defaultNewFrameServerHost(settings({ backendHost: "frames.lan", backendPort: 9000 }))).toBe(
      "frames.lan:9000",
    );
    expect(defaultNewFrameServerHost(settings({ backendHost: "https://frames.example.com/" }))).toBe(
      "https://frames.example.com:8989",
    );
    expect(defaultNewFrameServerHost(settings({ backendHost: "https://frames.example.com:8443/x" }))).toBe(
      "https://frames.example.com:8443",
    );
    expect(defaultNewFrameServerHost(settings({ backendHost: "[fd00::10]:8989" }))).toBe("[fd00::10]:8989");
  });

  it("gives a bare configured host the detected scheme only when it names the same port", () => {
    browserAt("https://homeassistant.local:8123/api/hassio_ingress/abc/", {
      HASSIO_RUN_MODE: "ingress",
      public_scheme: "https",
    });
    // Same port 8989: the certificate's host name for this very add-on.
    expect(defaultNewFrameServerHost(settings({ backendHost: "ha.example.com" }))).toBe(
      "https://ha.example.com:8989",
    );
    // Another port is another server (a reverse proxy, say): no guess.
    expect(defaultNewFrameServerHost(settings({ backendHost: "ha.example.com:9443" }))).toBe("ha.example.com:9443");
    // An explicit http:// is kept as http even on a TLS add-on.
    expect(defaultNewFrameServerHost(settings({ backendHost: "http://ha.example.com" }))).toBe(
      "ha.example.com:8989",
    );
  });
});

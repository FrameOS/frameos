import { describe, expect, it } from "vitest";
import {
  allowedDeviceScopes,
  defaultDeviceScopes,
  deviceScopeDescriptions,
  parseClientKind,
  parseScopes,
  safeLocalOrigin,
} from "./device-flow";

describe("safeLocalOrigin", () => {
  it("accepts http and https origins and reduces them to the origin", () => {
    expect(safeLocalOrigin("http://192.168.1.20:8989/path")).toBe(
      "http://192.168.1.20:8989",
    );
    expect(safeLocalOrigin("https://backend.local")).toBe(
      "https://backend.local",
    );
  });

  it("rejects non-http(s) schemes", () => {
    expect(safeLocalOrigin("file:///etc/passwd")).toBeUndefined();
    expect(safeLocalOrigin("javascript:alert(1)")).toBeUndefined();
    expect(safeLocalOrigin("ftp://example.com")).toBeUndefined();
  });

  it("rejects embedded credentials", () => {
    expect(safeLocalOrigin("http://user:pass@example.com")).toBeUndefined();
  });

  it("rejects empty and non-string values", () => {
    expect(safeLocalOrigin("")).toBeUndefined();
    expect(safeLocalOrigin("   ")).toBeUndefined();
    expect(safeLocalOrigin("not a url")).toBeUndefined();
    expect(safeLocalOrigin(undefined)).toBeUndefined();
    expect(safeLocalOrigin(42)).toBeUndefined();
  });

  it("accepts the addresses a self-hosted install can actually have", () => {
    expect(safeLocalOrigin("http://localhost:8989")).toBe("http://localhost:8989");
    expect(safeLocalOrigin("http://127.0.0.1:8989")).toBe("http://127.0.0.1:8989");
    expect(safeLocalOrigin("http://10.1.2.3")).toBe("http://10.1.2.3");
    expect(safeLocalOrigin("http://172.16.0.9")).toBe("http://172.16.0.9");
    expect(safeLocalOrigin("http://frame.local:8787")).toBe("http://frame.local:8787");
  });

  it("rejects public origins", () => {
    // The consent screen shows this as "Request from" and the login handoff
    // uses it as the redirect_uri allowlist, so a public origin here is how a
    // phishing link looks legitimate and then collects login codes.
    expect(safeLocalOrigin("https://frameos.example.com")).toBeUndefined();
    expect(safeLocalOrigin("http://8.8.8.8")).toBeUndefined();
    expect(safeLocalOrigin("https://172.32.0.1")).toBeUndefined();
    expect(safeLocalOrigin("https://192.169.1.1")).toBeUndefined();
  });

  it("applies the IPv6 prefix checks to IPv6 literals only", () => {
    // "fd…" and "fc…" are unique-local IPv6 prefixes — for literals. A DNS
    // name that happens to start with those letters is a public host.
    expect(safeLocalOrigin("https://fdcloud.example.com")).toBeUndefined();
    expect(safeLocalOrigin("https://fc.attacker.net")).toBeUndefined();
    expect(safeLocalOrigin("https://fe80.example.com")).toBeUndefined();
    expect(safeLocalOrigin("http://[fd12:3456::1]:8989")).toBe(
      "http://[fd12:3456::1]:8989",
    );
    expect(safeLocalOrigin("http://[fe80::1]")).toBe("http://[fe80::1]");
    expect(safeLocalOrigin("http://[::1]:8989")).toBe("http://[::1]:8989");
    expect(safeLocalOrigin("http://[2001:db8::1]")).toBeUndefined();
  });
});

describe("parseClientKind", () => {
  it("honors an explicit client_kind", () => {
    expect(parseClientKind("frame", ["backend:link"])).toBe("frame");
    expect(parseClientKind("backend", ["frame:link"])).toBe("backend");
  });

  it("derives the kind from the base scope when not explicit", () => {
    expect(parseClientKind(undefined, ["frame:link", "auth:login"])).toBe(
      "frame",
    );
    expect(parseClientKind(undefined, ["backend:link", "backend:read"])).toBe(
      "backend",
    );
  });

  it("ignores junk values and falls back to scope derivation", () => {
    expect(parseClientKind("toaster", ["frame:link"])).toBe("frame");
    expect(parseClientKind(42, ["backend:link"])).toBe("backend");
  });
});

describe("parseScopes", () => {
  it("keeps allowlisted scopes and drops unknown ones", () => {
    expect(
      parseScopes(["backend:link", "auth:login", "foo:bar"]),
    ).toEqual(["backend:link", "auth:login"]);
  });

  it("falls back to the defaults when nothing valid was requested", () => {
    expect(parseScopes(undefined)).toEqual(defaultDeviceScopes);
    expect(parseScopes("backend:link")).toEqual(defaultDeviceScopes);
    expect(parseScopes([])).toEqual(defaultDeviceScopes);
    expect(parseScopes(["foo:bar", 42])).toEqual(defaultDeviceScopes);
  });

  it("has a user-facing description for every allowed scope", () => {
    for (const scope of allowedDeviceScopes) {
      expect(deviceScopeDescriptions[scope]).toBeTruthy();
    }
    expect(allowedDeviceScopes.has("frame:link")).toBe(true);
    expect(allowedDeviceScopes.has("remote:access")).toBe(true);
  });
});

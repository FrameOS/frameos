import { describe, expect, it } from "vitest";
import { parseCookieHeader, sessionCookieCandidates } from "./session-auth";

describe("parseCookieHeader", () => {
  it("parses multiple cookies and trims whitespace", () => {
    const cookies = parseCookieHeader(
      "a=1; frameos_cloud_session=abc.def.ghi ;b=2",
    );
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("frameos_cloud_session")).toBe("abc.def.ghi");
    expect(cookies.get("b")).toBe("2");
  });

  it("keeps the first value when a name repeats", () => {
    const cookies = parseCookieHeader("x=first; x=second");
    expect(cookies.get("x")).toBe("first");
  });

  it("decodes percent-encoded values and survives bad encodings", () => {
    expect(parseCookieHeader("x=a%20b").get("x")).toBe("a b");
    expect(parseCookieHeader("x=%E0%A4%A").get("x")).toBe("%E0%A4%A");
  });

  it("returns an empty map for missing headers and junk", () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader("no-equals-sign").size).toBe(0);
  });
});

describe("sessionCookieCandidates", () => {
  it("covers the dev and both production cookie names from auth-web", () => {
    expect(sessionCookieCandidates).toEqual([
      "__Host-frameos_cloud_session",
      "__Secure-frameos_cloud_session",
      "frameos_cloud_session",
    ]);
  });
});

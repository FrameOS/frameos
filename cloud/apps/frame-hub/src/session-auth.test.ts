import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  // Cross-check against the real source of truth. auth-web's session.ts
  // imports next/headers and cannot be imported from this service, so the
  // declaration is read from disk instead — an added, removed, or renamed
  // cookie name in auth-web fails here rather than silently leaving the hub
  // unable to authenticate browser sockets.
  it("matches every cookie name auth-web's session.ts can mint", () => {
    const sessionSource = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../auth-web/src/lib/session.ts",
      ),
      "utf8",
    );
    const declaration = /export const sessionCookieName =([\s\S]*?);\n/.exec(
      sessionSource,
    )?.[1];
    expect(declaration).toBeDefined();
    // Cookie names only — the declaration also branches on NODE_ENV. A rename
    // to something that is not *_session empties this list, which the
    // non-empty assertion below turns into a failure.
    const minted = [...(declaration ?? "").matchAll(/"([^"]*session)"/gi)].map(
      (match) => match[1],
    );
    expect(minted.length).toBeGreaterThan(0);
    expect([...minted].sort()).toEqual([...sessionCookieCandidates].sort());
  });
});

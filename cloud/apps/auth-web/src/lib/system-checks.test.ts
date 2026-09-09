import { describe, expect, it } from "vitest";
import { publicBaseUrlUnderCookieDomain } from "./system-checks";

// The session cookie is domain-scoped so three origins share one login; a
// CDN alias under that domain receives the cookie on every image fetch.
describe("publicBaseUrlUnderCookieDomain", () => {
  it("flags a CDN alias beneath the cookie domain", () => {
    expect(
      publicBaseUrlUnderCookieDomain("frameos.net", "https://cloud-cdn.frameos.net"),
    ).toBe(true);
    expect(
      publicBaseUrlUnderCookieDomain(".frameos.net", "https://cloud-cdn.frameos.net/"),
    ).toBe(true);
    expect(publicBaseUrlUnderCookieDomain("frameos.net", "https://frameos.net")).toBe(
      true,
    );
  });

  it("accepts a CDN on its own registrable domain, and no config at all", () => {
    expect(
      publicBaseUrlUnderCookieDomain("frameos.net", "https://cdn.frameos-cdn.net"),
    ).toBe(false);
    // A suffix match is not a subdomain.
    expect(
      publicBaseUrlUnderCookieDomain("frameos.net", "https://notframeos.net"),
    ).toBe(false);
    expect(publicBaseUrlUnderCookieDomain(undefined, "https://x.frameos.net")).toBe(
      false,
    );
    expect(publicBaseUrlUnderCookieDomain("frameos.net", undefined)).toBe(false);
    expect(publicBaseUrlUnderCookieDomain("frameos.net", "not a url")).toBe(false);
  });
});

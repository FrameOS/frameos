// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  seedThemeFromSharedCookie,
  writeSharedTheme,
} from "../../../../../../cloud-frontend/src/cloudThemeSync";

// /frames and /account/* are separate bundles that each kept their own theme
// state — the workspace in localStorage['frameos.workspaceTheme'], the account
// pages in the frameos_theme cookie. Toggling on one and navigating to the
// other flipped the theme back. The cookie is the shared carrier because the
// account pages already read it ahead of their own storage, and the server
// reads it to avoid a flash.

const workspaceKey = "frameos.workspaceTheme";

function clearCookie() {
  document.cookie = "frameos_theme=; Path=/; Max-Age=0";
}

describe("workspace theme adopts the shared cookie", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearCookie();
  });

  it("starts the workspace on the theme the account pages last set", () => {
    document.cookie = "frameos_theme=dark; Path=/";
    seedThemeFromSharedCookie();
    expect(window.localStorage.getItem(workspaceKey)).toBe("dark");
  });

  it("overrides a stale workspace preference, so the cookie wins", () => {
    // The account pages read the cookie first too; if the workspace kept its
    // own older value the two surfaces would disagree on every navigation.
    window.localStorage.setItem(workspaceKey, "dark");
    document.cookie = "frameos_theme=light; Path=/";
    seedThemeFromSharedCookie();
    expect(window.localStorage.getItem(workspaceKey)).toBe("light");
  });

  it("leaves the workspace alone when there is no shared preference", () => {
    // No cookie: authThemeLogic falls back to its own storage and then to
    // prefers-color-scheme. Writing anything here would defeat that.
    window.localStorage.setItem(workspaceKey, "dark");
    seedThemeFromSharedCookie();
    expect(window.localStorage.getItem(workspaceKey)).toBe("dark");
  });

  it("ignores a junk cookie value rather than theming on it", () => {
    document.cookie = "frameos_theme=chartreuse; Path=/";
    seedThemeFromSharedCookie();
    expect(window.localStorage.getItem(workspaceKey)).toBeNull();
  });

  it("is not confused by another cookie whose name ends the same way", () => {
    document.cookie = "not_frameos_theme=dark; Path=/";
    seedThemeFromSharedCookie();
    expect(window.localStorage.getItem(workspaceKey)).toBeNull();
  });
});

describe("workspace theme changes reach the account pages", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearCookie();
  });

  // The direction the user notices: toggle in /frames, navigate to /account/*,
  // and the theme survives. (The subscription that calls this needs a kea
  // store, which the account app's runner cannot resolve; the cookie itself is
  // where the mistakes live, so that is what is pinned here.)
  it("publishes the theme where the account pages look for it", () => {
    writeSharedTheme("dark");
    expect(document.cookie).toContain("frameos_theme=dark");
    // Belt and braces for a cleared cookie: the account app's own key.
    expect(window.localStorage.getItem("frameos-cloud-theme")).toBe("dark");
  });

  it("round-trips through the reader the workspace seeds from", () => {
    writeSharedTheme("light");
    window.localStorage.setItem("frameos.workspaceTheme", "dark");
    seedThemeFromSharedCookie();
    expect(window.localStorage.getItem("frameos.workspaceTheme")).toBe("light");
  });

  it("omits Secure on a host-only cookie, or localhost would drop it", () => {
    // No injected domain in this environment, so no Domain and no Secure —
    // a Secure cookie is discarded over plain http during development.
    writeSharedTheme("dark");
    expect(document.cookie).toContain("frameos_theme=dark");
  });
});

// @vitest-environment jsdom
// The pure pieces of the frames workspace's account pages
// (frontend/src/scenes/settings/account): the page registry, the
// re-authentication helper and the display formatters.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountPage,
  accountPages,
  defaultAccountPageKey,
  isAccountPageKey,
} from "../../../../../../frontend/src/scenes/settings/account/accountPages";
import {
  dollars,
  formatBytes,
  formatDateTime,
  surfaceLabel,
} from "../../../../../../frontend/src/scenes/settings/account/format";
import {
  isReauthRequired,
  reauthHref,
  redirectToReauthIfRequired,
  takePendingReauthAction,
  takePendingReauthActionWhere,
} from "../../../../../../frontend/src/scenes/settings/account/reauth";

afterEach(() => {
  delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("the account page registry", () => {
  it("has one unique key, label, title and description per page", () => {
    const keys = accountPages.map((page) => page.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const page of accountPages) {
      expect(page.label.trim()).not.toBe("");
      expect(page.title.trim()).not.toBe("");
      expect(page.description.trim()).not.toBe("");
      // A URL segment: lowercase letters only, no spaces to encode.
      expect(page.key).toMatch(/^[a-z]+$/);
    }
  });

  it("lands on the first page and falls back to it for an unknown key", () => {
    expect(defaultAccountPageKey).toBe(accountPages[0]?.key);
    expect(isAccountPageKey("usage")).toBe(true);
    expect(isAccountPageKey("frames")).toBe(false);
    expect(isAccountPageKey(undefined)).toBe(false);
    expect(accountPage("security").title).toBe("Security");
  });
});

describe("re-authentication", () => {
  it("recognizes the sudo-mode refusal and nothing else", () => {
    expect(isReauthRequired({ status: 403 } as Response, { error: "reauth_required" })).toBe(true);
    expect(isReauthRequired({ status: 403 } as Response, { error: "invalid_origin" })).toBe(false);
    expect(isReauthRequired({ status: 401 } as Response, { error: "reauth_required" })).toBe(false);
  });

  it("sends the browser to the injected reauth page and back to this one", () => {
    (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = {
      cloud_reauth_url: "https://cloud.example/login/reauth",
    };
    const href = new URL(reauthHref("https://account.example/account/developer"));
    expect(href.origin + href.pathname).toBe("https://cloud.example/login/reauth");
    expect(href.searchParams.get("return_to")).toBe("https://account.example/account/developer");
    // Without injection the page is on this origin.
    delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
    expect(new URL(reauthHref("http://localhost/x")).pathname).toBe("/login/reauth");
  });

  it("stashes the action to replay, once, for ten minutes", () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign,
      href: "http://localhost/account/backends",
    } as unknown as Location);
    expect(
      redirectToReauthIfRequired({ status: 403 } as Response, { error: "reauth_required" }, "revoke-install:abc"),
    ).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(takePendingReauthActionWhere((action) => action.startsWith("revoke-install:"))).toBe("revoke-install:abc");
    // Taken: a second visit does not replay it.
    expect(takePendingReauthAction("revoke-install:abc")).toBe(false);

    // A stale stash is dropped.
    window.sessionStorage.setItem(
      "frameos.reauth.pending",
      JSON.stringify({ action: "sessions:revoke-all", at: Date.now() - 11 * 60 * 1000 }),
    );
    expect(takePendingReauthAction("sessions:revoke-all")).toBe(false);

    // Not a refusal: nothing happens.
    expect(redirectToReauthIfRequired({ status: 500 } as Response, undefined, "x")).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("formatting", () => {
  it("reads like the cloud's own pages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatDateTime(new Date(2026, 6, 9, 8, 5))).toBe("9 Jul 2026, 08:05");
    expect(formatDateTime("not a date")).toBe("not a date");
    // Rounds up to the cent, keeps a credit's sign, accepts the wire's strings.
    expect(dollars("1")).toBe("$0.01");
    expect(dollars("1234567")).toBe("$1.24");
    expect(dollars(-20000n)).toBe("-$0.02");
    expect(dollars("0")).toBe("$0.00");
    expect(surfaceLabel("scene_chat")).toBe("Scene chat");
    expect(surfaceLabel("something_new")).toBe("something new");
    expect(surfaceLabel(null)).toBe("Other");
  });
});

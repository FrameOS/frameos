// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyFrameosFavicon,
  applyFrameosTheme,
} from "../../../../../../frontend/src/utils/frameosTheme";

// A favicon is painted into the TAB STRIP, not the page, so the only thing it
// has to contrast with is the browser chrome. It used to follow the workspace
// theme instead — so a dark Chrome showing a light-themed workspace got the
// black glyph on a dark strip, where it was all but invisible.
//
// The other axis is the hostname: a loopback origin drops the three colours,
// which is what tells a dev tab apart from the real deployment.

type MediaListener = () => void;

let darkChrome = false;
// NOT reset between tests, on purpose: the module registers its
// prefers-color-scheme listener exactly once per page load (one page = one
// listener, no leak on repeated repaints), so clearing this would throw away
// the only registration the module will ever make.
const listeners: MediaListener[] = [];

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark") && darkChrome,
    media: query,
    addEventListener: (_: string, fn: MediaListener) => {
      listeners.push(fn);
    },
    removeEventListener: () => {},
  }));
}

function setHostname(hostname: string) {
  // jsdom's location is read-only; replacing the whole object is the usual
  // escape hatch and is enough for the `window.location.hostname` read.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, hostname },
    writable: true,
  });
}

function faviconHref() {
  return document
    .querySelector("link[data-frameos-favicon]")
    ?.getAttribute("href");
}

describe("favicon follows the browser, not the workspace theme", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    darkChrome = false;
    stubMatchMedia();
    setHostname("account.frameos.net");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the white glyph on a dark browser even when the app is light", () => {
    darkChrome = true;
    applyFrameosTheme("light");

    // The regression: this used to resolve to the plain (dark-glyph) logo.
    expect(faviconHref()).toBe("/img/logo-2/logo-white-colors.svg");
    expect(document.documentElement.dataset.frameosTheme).toBe("light");
  });

  it("uses the dark glyph on a light browser even when the app is dark", () => {
    darkChrome = false;
    applyFrameosTheme("dark");

    expect(faviconHref()).toBe("/img/logo-2/logo.svg");
    expect(document.documentElement.dataset.frameosTheme).toBe("dark");
  });

  it("drops the colours on a loopback origin, on both browser schemes", () => {
    setHostname("localhost");

    darkChrome = true;
    applyFrameosFavicon();
    expect(faviconHref()).toBe("/img/logo-2/logo-white.svg");

    darkChrome = false;
    applyFrameosFavicon();
    expect(faviconHref()).toBe("/img/logo-2/logo-black.svg");
  });

  it("keeps the colours on a LAN or mDNS host — those are real deployments", () => {
    for (const host of ["192.168.1.40", "frame.local", "cloud.frameos.net"]) {
      setHostname(host);
      applyFrameosFavicon();
      expect(faviconHref()).toBe("/img/logo-2/logo.svg");
    }
  });

  it("repaints when the browser switches scheme, with the app theme untouched", () => {
    applyFrameosTheme("light");
    expect(faviconHref()).toBe("/img/logo-2/logo.svg");

    // Nothing else in the app re-runs on this event — the workspace theme may
    // be pinned to light and entirely unaffected — so the icon needs its own
    // listener or it would stay wrong until a reload.
    expect(listeners.length).toBeGreaterThan(0);
    darkChrome = true;
    for (const fire of listeners) {
      fire();
    }

    expect(faviconHref()).toBe("/img/logo-2/logo-white-colors.svg");
    expect(document.documentElement.dataset.frameosTheme).toBe("light");
  });

  it("reuses the one link element rather than stacking them up", () => {
    applyFrameosFavicon();
    applyFrameosFavicon();
    darkChrome = true;
    applyFrameosFavicon();

    expect(document.querySelectorAll("link[data-frameos-favicon]")).toHaveLength(
      1,
    );
  });
});

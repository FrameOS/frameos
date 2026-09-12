// @vitest-environment jsdom

// Every object URL the frontend mints goes through utils/objectUrl.ts: the
// code base had three revocation conventions (revoke after the download
// click, a 60 s timer, never) and one leaked blob per never (2026-09
// review). Pins that each helper revokes exactly what it created.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_IN_NEW_TAB_REVOKE_FALLBACK_MS,
  downloadBlob,
  downloadJson,
  openBlobInNewTab,
  withObjectUrl,
} from "../../../../../../frontend/src/utils/objectUrl";

const created: Blob[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      created.push(blob);
      return `blob:test/${created.length}`;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("downloadBlob", () => {
  it("clicks a link for the blob and revokes the URL once the click is dispatched", () => {
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.download}@${this.href}`);
      expect(revoked).toEqual([]);
      expect(document.body.contains(this)).toBe(true);
    });
    downloadBlob(new Blob(["x"]), "x.txt");
    expect(clicks).toEqual(["x.txt@blob:test/1"]);
    expect(revoked).toEqual(["blob:test/1"]);
    expect(document.querySelector("a")).toBeNull();
    click.mockRestore();
  });

  it("serialises JSON with a trailing newline", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadJson({ a: 1 }, "a.json");
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("application/json");
    expect(await created[0]!.text()).toBe('{\n  "a": 1\n}\n');
    click.mockRestore();
  });
});

describe("withObjectUrl", () => {
  it("revokes after the callback settles, whichever way", async () => {
    await expect(
      withObjectUrl(new Blob(["x"]), async (url) => {
        expect(url).toBe("blob:test/1");
        expect(revoked).toEqual([]);
        return "done";
      })
    ).resolves.toBe("done");
    expect(revoked).toEqual(["blob:test/1"]);

    await expect(
      withObjectUrl(new Blob(["y"]), async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
  });
});

describe("openBlobInNewTab", () => {
  it("mints nothing when the popup was blocked", () => {
    openBlobInNewTab(new Blob(["x"]), null);
    expect(created).toEqual([]);
  });

  it("points the window at the blob and revokes once it has loaded, once", () => {
    vi.useFakeTimers();
    const listeners: Array<() => void> = [];
    const win = {
      location: { href: "" },
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    } as unknown as Window;
    openBlobInNewTab(new Blob(["x"]), win);
    expect(win.location.href).toBe("blob:test/1");
    expect(revoked).toEqual([]);
    listeners.forEach((listener) => listener());
    expect(revoked).toEqual(["blob:test/1"]);
    vi.advanceTimersByTime(OPEN_IN_NEW_TAB_REVOKE_FALLBACK_MS);
    expect(revoked).toEqual(["blob:test/1"]);
  });

  it("falls back to a timer for a window that never reports a load", () => {
    vi.useFakeTimers();
    const win = { location: { href: "" }, addEventListener: () => {} } as unknown as Window;
    openBlobInNewTab(new Blob(["x"]), win);
    vi.advanceTimersByTime(OPEN_IN_NEW_TAB_REVOKE_FALLBACK_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(["blob:test/1"]);
  });
});

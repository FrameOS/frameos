// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSceneDraft,
  readSceneDraft,
  sceneDraftKey,
  sceneDraftMaxAgeMs,
  sceneDraftMaxBytes,
  writeSceneDraft,
  type SceneEditorDraft,
} from "./scene-draft";

const draft: SceneEditorDraft = {
  baseVersion: 2,
  images: ["a".repeat(64)],
  listing: { category: "clocks", description: "Big", frameosVersion: null, tags: ["clock"] },
  savedAt: "2026-08-31T10:00:00.000Z",
  scenes: [{ id: "s1", name: "Clock" }],
};

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scene drafts", () => {
  it("round-trips a draft per scene", () => {
    writeSceneDraft("scene-1", draft);
    expect(readSceneDraft("scene-1")).toEqual(draft);
    expect(readSceneDraft("scene-2")).toBeNull();
    clearSceneDraft("scene-1");
    expect(readSceneDraft("scene-1")).toBeNull();
  });

  it("keeps a null baseVersion (no versions known yet)", () => {
    writeSceneDraft("scene-1", { ...draft, baseVersion: null });
    expect(readSceneDraft("scene-1")?.baseVersion).toBeNull();
  });

  it("drops malformed drafts, removing them", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...draft, scenes: [] }),
      JSON.stringify({ ...draft, scenes: "nope" }),
      JSON.stringify({ ...draft, listing: null }),
      JSON.stringify({ ...draft, images: "nope" }),
      JSON.stringify({ ...draft, savedAt: 12345 }),
    ]) {
      window.localStorage.setItem(sceneDraftKey("scene-1"), raw);
      expect(readSceneDraft("scene-1")).toBeNull();
      // "not json" throws before the removal; every parsed-but-bad shape
      // is swept.
      if (raw !== "not json") {
        expect(window.localStorage.getItem(sceneDraftKey("scene-1"))).toBeNull();
      }
    }
  });

  it("expires old drafts on read", () => {
    writeSceneDraft("scene-1", {
      ...draft,
      savedAt: new Date(Date.now() - sceneDraftMaxAgeMs - 1000).toISOString(),
    });
    expect(readSceneDraft("scene-1")).toBeNull();
    expect(window.localStorage.getItem(sceneDraftKey("scene-1"))).toBeNull();
  });

  it("keeps a draft just inside the expiry window", () => {
    const savedAt = new Date(Date.now() - sceneDraftMaxAgeMs + 60_000).toISOString();
    writeSceneDraft("scene-1", { ...draft, savedAt });
    expect(readSceneDraft("scene-1")?.savedAt).toBe(savedAt);
  });

  it("skips drafts too big to store", () => {
    writeSceneDraft("scene-1", {
      ...draft,
      scenes: [{ id: "s1", blob: "x".repeat(sceneDraftMaxBytes) }],
    });
    expect(window.localStorage.getItem(sceneDraftKey("scene-1"))).toBeNull();
  });

  it("survives storage that throws", () => {
    const failing = {
      getItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("localStorage", failing);
    try {
      expect(() => writeSceneDraft("scene-1", draft)).not.toThrow();
      expect(readSceneDraft("scene-1")).toBeNull();
      expect(() => clearSceneDraft("scene-1")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNewSceneDraft,
  draftIdFromHash,
  hashForDraftId,
  newSceneDraftId,
  newSceneDraftKey,
  newSceneDraftMaxAgeMs,
  newSceneDraftMaxBytes,
  newSceneDraftsKept,
  readNewSceneDraft,
  sweepNewSceneDrafts,
  writeNewSceneDraft,
  type NewSceneDraft,
} from "./new-scene-draft";

const draft: NewSceneDraft = {
  chat: {
    chatId: "chat-1",
    messages: [
      { content: "show a big pineapple", role: "user" },
      { content: "Made a bold, sunny pineapple.", role: "assistant" },
    ],
  },
  presetIndex: 2,
  savedAt: "2026-08-31T12:00:00.000Z",
  scenes: [{ id: "s1", name: "Pineapple" }],
  selectedSceneId: "s1",
};

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("new-scene drafts", () => {
  it("round-trips a draft per draft id", () => {
    writeNewSceneDraft("abc123", draft);
    expect(readNewSceneDraft("abc123")).toEqual(draft);
    expect(readNewSceneDraft("other")).toBeNull();
    clearNewSceneDraft("abc123");
    expect(readNewSceneDraft("abc123")).toBeNull();
  });

  it("drops a draft older than the maximum age, and the entry with it", () => {
    writeNewSceneDraft("abc123", {
      ...draft,
      savedAt: new Date(Date.now() - newSceneDraftMaxAgeMs - 1000).toISOString(),
    });
    expect(readNewSceneDraft("abc123")).toBeNull();
    expect(window.localStorage.getItem(newSceneDraftKey("abc123"))).toBeNull();
  });

  it("ignores malformed and empty drafts", () => {
    window.localStorage.setItem(newSceneDraftKey("bad"), "{oops");
    expect(readNewSceneDraft("bad")).toBeNull();
    writeNewSceneDraft("empty", { ...draft, scenes: [] });
    expect(readNewSceneDraft("empty")).toBeNull();
  });

  it("skips a draft too big to store rather than half-writing it", () => {
    writeNewSceneDraft("big", {
      ...draft,
      scenes: [{ id: "s1", name: "x".repeat(newSceneDraftMaxBytes) }],
    });
    expect(window.localStorage.getItem(newSceneDraftKey("big"))).toBeNull();
  });

  it("keeps a chat only when it has messages", () => {
    writeNewSceneDraft("a", { ...draft, chat: { chatId: "chat-1", messages: [] } });
    expect(readNewSceneDraft("a")?.chat).toBeNull();
  });

  it("sweeps expired drafts and everything past the newest few", () => {
    const at = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    for (let index = 0; index < newSceneDraftsKept + 3; index += 1) {
      // Written oldest first; the newest is the last one written.
      window.localStorage.setItem(
        newSceneDraftKey(`d${index}`),
        JSON.stringify({ ...draft, savedAt: at(newSceneDraftsKept + 3 - index) }),
      );
    }
    window.localStorage.setItem(
      newSceneDraftKey("ancient"),
      JSON.stringify({ ...draft, savedAt: at(newSceneDraftMaxAgeMs / 60_000 + 1) }),
    );
    sweepNewSceneDrafts();
    const left = Object.keys(window.localStorage)
      .filter((key) => key.startsWith("frameos:new-scene-draft:"))
      .sort();
    expect(left).toEqual(["d3", "d4", "d5", "d6", "d7"].map(newSceneDraftKey).sort());
  });

  it("never sweeps the draft just written, even past the budget", () => {
    for (let index = 0; index < newSceneDraftsKept + 2; index += 1) {
      writeNewSceneDraft(`d${index}`, {
        ...draft,
        savedAt: new Date(Date.now() - index).toISOString(),
      });
    }
    // The last write is the newest, so it survives on its own merits too.
    expect(readNewSceneDraft(`d${newSceneDraftsKept + 1}`)).not.toBeNull();
    expect(
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith("frameos:new-scene-draft:"),
      ),
    ).toHaveLength(newSceneDraftsKept);
  });

  it("reads the draft id out of the URL hash", () => {
    expect(draftIdFromHash("#d=abc123")).toBe("abc123");
    expect(draftIdFromHash(hashForDraftId("f00d"))).toBe("f00d");
    expect(draftIdFromHash("")).toBeNull();
    expect(draftIdFromHash("#panels=ai")).toBeNull();
    expect(draftIdFromHash("#d=has spaces")).toBeNull();
  });

  it("mints ids that differ", () => {
    expect(newSceneDraftId()).not.toBe(newSceneDraftId());
    expect(draftIdFromHash(hashForDraftId(newSceneDraftId()))).not.toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  PREVIEW_KEY_DECISIONS_STORAGE_KEY,
  previewKeyGroupsRemembered,
  previewKeyGroupsToAsk,
  readRememberedPreviewKeyDecisions,
  rememberPreviewKeyDecisions,
  settingsWithoutGroups,
} from "../../../../../../frontend/src/scenes/frame/panels/Scenes/previewKeyConsent";
import type {
  AppConfig,
  FrameScene,
} from "../../../../../../frontend/src/types";

// A browser preview hands a scene's data apps the account's real keys. A
// scene the owner wrote gets them on the click; a store scene asks, per
// settings group, and the answer can be remembered per group.

const apps: Record<string, AppConfig> = {
  openAiImage: { name: "OpenAI image", settings: ["openAI"] } as AppConfig,
  unsplashPhoto: { name: "Unsplash", settings: ["unsplash"] } as AppConfig,
  clock: { name: "Clock" } as AppConfig,
};

function scene(id: string, keywords: string[], store = false): FrameScene {
  return {
    id,
    name: id,
    nodes: keywords.map((keyword, index) => ({
      id: `${id}-${index}`,
      type: "app",
      data: { keyword },
      position: { x: 0, y: 0 },
    })),
    edges: [],
    ...(store ? { origin: { storeSceneId: "11111111-2222-3333-4444-555555555555" } } : {}),
  } as unknown as FrameScene;
}

const settings = {
  openAI: { apiKey: "sk-1" },
  unsplash: { accessKey: "" },
  github: { api_key: "gh" },
};

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("previewKeyGroupsToAsk", () => {
  it("asks only for store scenes' groups that actually have a value", () => {
    const scenes = [scene("own", ["openAiImage"]), scene("store", ["openAiImage", "unsplashPhoto"], true)];
    // unsplash has no value to hand over, so it is not asked about.
    expect(previewKeyGroupsToAsk(scenes, apps, settings, {})).toEqual(["openAI"]);
  });

  it("never asks for owner-authored scenes", () => {
    expect(previewKeyGroupsToAsk([scene("own", ["openAiImage"])], apps, settings, {})).toEqual([]);
  });

  it("skips groups with a remembered answer either way", () => {
    const scenes = [scene("store", ["openAiImage"], true)];
    expect(previewKeyGroupsToAsk(scenes, apps, settings, { openAI: "allow" })).toEqual([]);
    expect(previewKeyGroupsToAsk(scenes, apps, settings, { openAI: "deny" })).toEqual([]);
  });

  it("treats every scene of a store template preview as store code", () => {
    const scenes = [scene("template", ["openAiImage"])];
    expect(previewKeyGroupsToAsk(scenes, apps, settings, {}, true)).toEqual(["openAI"]);
  });
});

describe("remembered decisions", () => {
  it("round-trips per group and only keeps valid values", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREVIEW_KEY_DECISIONS_STORAGE_KEY, JSON.stringify({ github: "maybe", openAI: "deny" }));
    expect(readRememberedPreviewKeyDecisions(storage)).toEqual({ openAI: "deny" });
    const next = rememberPreviewKeyDecisions({ decision: "allow", remember: ["unsplash"] }, storage);
    expect(next).toEqual({ openAI: "deny", unsplash: "allow" });
    expect(readRememberedPreviewKeyDecisions(storage)).toEqual(next);
  });

  it("survives a broken store", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREVIEW_KEY_DECISIONS_STORAGE_KEY, "{not json");
    expect(readRememberedPreviewKeyDecisions(storage)).toEqual({});
  });

  it("a remembered deny withholds the group from a store scene preview", () => {
    const scenes = [scene("store", ["openAiImage", "unsplashPhoto"], true)];
    const { allowed, denied } = previewKeyGroupsRemembered(scenes, apps, { openAI: "deny", unsplash: "allow" });
    expect(denied).toEqual(["openAI"]);
    expect(allowed).toEqual(["unsplash"]);
    expect(settingsWithoutGroups(settings, denied)).toEqual({
      unsplash: { accessKey: "" },
      github: { api_key: "gh" },
    });
  });
});

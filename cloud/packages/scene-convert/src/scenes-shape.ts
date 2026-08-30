// The three shapes a scene file comes in — one scene, a scenes.json array,
// or an export with {"scenes": [...]} — and how to hand the result back in
// the shape it arrived in. Shared by the CLI, the cloud route and the page.

import type { Scene } from "./types";

export type ScenesShape = "scene" | "array" | "object";

export function unwrapScenes(parsed: unknown): { scenes: Scene[]; shape: ScenesShape } {
  if (Array.isArray(parsed)) {
    return { scenes: parsed as Scene[], shape: "array" };
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.scenes)) {
      return { scenes: record.scenes as Scene[], shape: "object" };
    }
    if (typeof record.id === "string") {
      return { scenes: [record as Scene], shape: "scene" };
    }
  }
  throw new Error("expected a scene object, an array of scenes, or {\"scenes\": [...]}");
}

export function rewrapScenes(original: unknown, scenes: Scene[], shape: ScenesShape): unknown {
  switch (shape) {
    case "scene":
      return scenes[0];
    case "array":
      return scenes;
    case "object":
      return { ...(original as Record<string, unknown>), scenes };
  }
}


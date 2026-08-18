// @vitest-environment jsdom
//
// The equality frameLogic hands to the cloud scene save
// (cloudScenePersistOptions → sceneEqualForComparison over sanitizeScene)
// against a REAL store scene: the public "Abstract Architecture" the account
// kept forking. Hydration sanitizes scenes.json into the form; the save
// sanitizes the stored copy the same way and compares. If sanitizeScene is
// not idempotent, or drifts between the two calls, an unedited scene reads
// as edited and the forks come back.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  sanitizeScene,
  sceneEqualForComparison,
} from "../../../../../../frontend/src/scenes/frame/frameLogic";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

// The fixture is the scene as the store holds it TODAY — version 8, i.e. the
// output of seven spurious republishes, so it is already in sanitized shape.
// A publisher's original never is (no positions, no settings defaults, no
// `apps`), so the raw side below is the fixture with those stripped again.
const stored = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "abstract-architecture.scenes.json"),
      "utf8",
    ),
  ) as FrameScene[]
).map((scene) => {
  const { apps: _apps, fields: _fields, ...rest } = scene as FrameScene & { apps?: unknown };
  const { execution: _execution, ...settings } = (scene.settings ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    settings,
    nodes: scene.nodes.map(({ position: _position, ...node }) => node),
  } as unknown as FrameScene;
});

const frame = { mode: "buildroot", interval: 300 } as Partial<FrameType>;

describe("cloud scene save equality", () => {
  it("sees a hydrated-then-resubmitted store scene as unedited", () => {
    // Hydration: sanitizeFrame → sanitizeScene(raw, frame). Submit:
    // normalizeFrameForSubmit → sanitizeScene(form, formFrame) again.
    const hydrated = stored.map((scene) => sanitizeScene(scene, frame));
    const submitted = hydrated.map((scene) => sanitizeScene(scene, { ...frame, interval: 600 }));
    for (const [index, raw] of stored.entries()) {
      // What cloudScenePersistOptions computes for each stored/form pair.
      expect(sceneEqualForComparison(sanitizeScene(raw, frame), sanitizeScene(submitted[index]!, frame))).toBe(true);
      // …and the raw JSON never matched, which is why the old flow forked.
      expect(JSON.stringify(raw) === JSON.stringify(submitted[index])).toBe(false);
    }
  });

  it("still tells a real edit apart", () => {
    const edited = stored.map((scene) => sanitizeScene(scene, frame));
    edited[0]!.nodes = edited[0]!.nodes.slice(1);
    expect(sceneEqualForComparison(sanitizeScene(stored[0]!, frame), sanitizeScene(edited[0]!, frame))).toBe(false);
  });
});

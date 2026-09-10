import { describe, expect, it } from "vitest";
import {
  buildScenesFromTemplate,
  cloudUndeployedChangeDetails,
  frameFormKeysEqual,
} from "../../../../../../frontend/src/scenes/frame/frameLogic";
import type {
  FrameScene,
  FrameType,
  TemplateType,
} from "../../../../../../frontend/src/types";

function frame(fields: Partial<FrameType>): FrameType {
  return fields as FrameType;
}

// Feedback from a real cloud buildroot install: the deploy drawer said
// "FrameOS 2026.8.20 → 2026.8.21" while the button that opens it stayed
// idle-white, so nothing outside the drawer ever suggested there was an
// upgrade to run.
describe("cloudUndeployedChangeDetails", () => {
  it("reports nothing when the device acked the push and runs the latest release", () => {
    expect(
      cloudUndeployedChangeDetails(
        frame({
          assigned_checksum: "abc",
          scenes_checksum: "abc",
          frameos_version: "2026.8.21",
        }),
        "2026.8.21",
      ),
    ).toEqual([]);
  });

  it("reports a version gap so the deploy indicator lights up", () => {
    const details = cloudUndeployedChangeDetails(
      frame({
        assigned_checksum: "abc",
        scenes_checksum: "abc",
        frameos_version: "2026.8.20",
      }),
      "2026.8.21",
    );

    expect(details).toHaveLength(1);
    expect(details[0]?.label).toBe("FrameOS 2026.8.20 → 2026.8.21");
    // Tagged so the dashboard status line reads "upgrade" rather than
    // "waiting to sync" — nothing is queued, the frame is simply behind.
    expect(details[0]?.frameosVersionChange).toEqual({
      kind: "upgrade",
      previousVersion: "2026.8.20",
      currentVersion: "2026.8.21",
    });
  });

  it("ignores the tag's v prefix, which device versions never carry", () => {
    expect(
      cloudUndeployedChangeDetails(
        frame({
          assigned_checksum: "abc",
          scenes_checksum: "abc",
          frameos_version: "v2026.8.21",
        }),
        "2026.8.21",
      ),
    ).toEqual([]);
  });

  it("claims no upgrade while the release lookup is unknown or failed", () => {
    for (const latest of [null, undefined, ""]) {
      expect(
        cloudUndeployedChangeDetails(
          frame({
            assigned_checksum: "abc",
            scenes_checksum: "abc",
            frameos_version: "2026.8.20",
          }),
          latest,
        ),
      ).toEqual([]);
    }
  });

  it("claims no upgrade for a frame that has not reported a version yet", () => {
    expect(
      cloudUndeployedChangeDetails(
        frame({ assigned_checksum: "abc", scenes_checksum: "abc" }),
        "2026.8.21",
      ),
    ).toEqual([]);
  });

  it("still reports an unacked push, alongside a version gap", () => {
    const details = cloudUndeployedChangeDetails(
      frame({
        assigned_checksum: "abc",
        scenes_checksum: "old",
        frameos_version: "2026.8.20",
      }),
      "2026.8.21",
    );

    expect(details.map((change) => change.label)).toEqual([
      "Waiting for the frame to apply the last push",
      "FrameOS 2026.8.20 → 2026.8.21",
    ]);
  });
});

// Feedback from the same install: a scene added from the FrameOS Cloud store
// landed on the frame with a permanently blank tile. The client-side copy was
// re-ided, but on the cloud those ids are a join key — /scene_images resolves
// a cover by walking the assigned store scenes' published scenes.json, and the
// save path matches a form scene back to its assignment the same way.
describe("buildScenesFromTemplate", () => {
  const template = {
    name: "Bird journal",
    scenes: [
      { id: "store-scene-1", name: "Bird journal", nodes: [], edges: [] },
    ] as unknown as FrameScene[],
  } as Partial<TemplateType>;

  it("keeps the published ids for a cloud store install", () => {
    const scenes = buildScenesFromTemplate(template, {}, true);

    expect(scenes.map((scene) => scene.id)).toEqual(["store-scene-1"]);
  });

  it("mints fresh ids everywhere else, because a template is a copy", () => {
    const scenes = buildScenesFromTemplate(template, {});

    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.id).not.toBe("store-scene-1");
  });

  it("drops a preserved scene the frame already has instead of duplicating its id", () => {
    const scenes = buildScenesFromTemplate(
      template,
      { scenes: [{ id: "store-scene-1" }] as unknown as FrameScene[] },
      true,
    );

    expect(scenes).toEqual([]);
  });
});

// frameLogic's `frame` subscription fires on every log line (the log reducer
// spreads the row to bump last_log_at / active_scene_id) and used to run the
// scene-deep "does the form still match the previous row?" diff each time.
// The gate in front of it is a per-key reference check, so a row that only
// moved a non-form field is settled without touching the scenes.
describe("frameFormKeysEqual", () => {
  const scenes = [{ id: "a", name: "A", nodes: [{ id: "n" }], edges: [] }] as unknown as FrameScene[];

  it("is true for a log-line spread of the same row, without deep-comparing the shared scenes", () => {
    // Any look inside the scene list is the deep compare this gate exists to skip.
    const untouchable = new Proxy(scenes, {
      get: (_target, property) => {
        throw new Error(`scenes deep-compared (read ${String(property)})`);
      },
    });
    const previous = frame({ name: "Kitchen", interval: 60, scenes: untouchable, last_log_at: "2026-09-10T10:00:00Z" });
    const next = { ...previous, last_log_at: "2026-09-10T10:00:01Z", active_scene_id: "a" };
    expect(frameFormKeysEqual(previous, next)).toBe(true);
  });

  it("is false when a form key moved, scenes included", () => {
    const previous = frame({ name: "Kitchen", interval: 60, scenes });
    expect(frameFormKeysEqual(previous, { ...previous, name: "Hall" })).toBe(false);
    expect(frameFormKeysEqual(previous, { ...previous, scenes: [...scenes, { id: "b" } as unknown as FrameScene] })).toBe(
      false,
    );
  });

  it("still sees through a re-serialised row (a fresh object from the server with equal values)", () => {
    const previous = frame({ name: "Kitchen", interval: 60, scenes });
    const next = frame({ name: "Kitchen", interval: 60, scenes: JSON.parse(JSON.stringify(scenes)) });
    expect(frameFormKeysEqual(previous, next)).toBe(true);
  });
});

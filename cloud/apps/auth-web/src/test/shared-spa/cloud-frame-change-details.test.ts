import { describe, expect, it } from "vitest";
import {
  buildScenesFromTemplate,
  cloudUndeployedChangeDetails,
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

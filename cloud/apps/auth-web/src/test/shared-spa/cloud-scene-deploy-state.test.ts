import { describe, expect, it } from "vitest";
import { undeployedSceneIdsFor } from "../../../../../../frontend/src/utils/sceneDeployState";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

// Bug: every scene in the cloud workspace claimed "This scene has changes that
// are not on the frame yet", including immediately after a successful push.
// The check read frame.last_successful_deploy.scenes — a backend field that
// nothing in the cloud ever writes — so it compared each scene against an
// empty list and marked them all pending, forever.
//
// The cloud's evidence is the checksum pair the account frames table already
// renders as "in sync" / "sync pending": assigned_checksum (what the account
// assigned) versus scenes_checksum (what the device acknowledged).

const scenes = [
  { id: "scene-a", name: "A", nodes: [], edges: [] },
  { id: "scene-b", name: "B", nodes: [], edges: [] },
] as unknown as FrameScene[];

function frame(fields: Partial<FrameType>): FrameType {
  return fields as FrameType;
}

// The cloud never has this field; a stub keeps the backend cases honest.
const scenesEqual = (a: FrameScene, b: FrameScene) =>
  JSON.stringify(a) === JSON.stringify(b);

describe("undeployedSceneIdsFor — cloud", () => {
  it("reports nothing pending once the device acknowledges the assigned set", () => {
    const ids = undeployedSceneIdsFor({
      mode: "cloud",
      scenes,
      frame: frame({ assigned_checksum: "abc", scenes_checksum: "abc" }),
      scenesEqual,
    });
    expect([...ids]).toEqual([]);
  });

  it("reports the whole set pending while the device is behind", () => {
    const ids = undeployedSceneIdsFor({
      mode: "cloud",
      scenes,
      frame: frame({ assigned_checksum: "new", scenes_checksum: "old" }),
      scenesEqual,
    });
    expect([...ids].sort()).toEqual(["scene-a", "scene-b"]);
  });

  it("reports pending when the device has not acknowledged anything yet", () => {
    const ids = undeployedSceneIdsFor({
      mode: "cloud",
      scenes,
      frame: frame({ assigned_checksum: "abc", scenes_checksum: null }),
      scenesEqual,
    });
    expect(ids.size).toBe(2);
  });

  it("leaves a frame with nothing assigned and nothing on the device alone", () => {
    const ids = undeployedSceneIdsFor({
      mode: "cloud",
      scenes: [],
      frame: frame({ assigned_checksum: null, scenes_checksum: null }),
      scenesEqual,
    });
    expect(ids.size).toBe(0);
  });

  it("ignores last_successful_deploy, which the cloud never writes", () => {
    // The old code path: with this field absent every scene looked undeployed.
    // Present-but-stale must not override the checksums either.
    const ids = undeployedSceneIdsFor({
      mode: "cloud",
      scenes,
      frame: frame({
        assigned_checksum: "abc",
        scenes_checksum: "abc",
        last_successful_deploy: { scenes: [] },
      } as Partial<FrameType>),
      scenesEqual,
    });
    expect(ids.size).toBe(0);
  });
});

describe("undeployedSceneIdsFor — other modes", () => {
  it("compares against last_successful_deploy on the backend", () => {
    const ids = undeployedSceneIdsFor({
      mode: "backend",
      scenes,
      frame: frame({
        last_successful_deploy: { scenes: [scenes[0]] },
      } as Partial<FrameType>),
      scenesEqual,
    });
    expect([...ids]).toEqual(["scene-b"]);
  });

  it("has nothing to deploy in frame admin mode", () => {
    const ids = undeployedSceneIdsFor({
      mode: "frameAdmin",
      scenes,
      frame: frame({}),
      scenesEqual,
    });
    expect(ids.size).toBe(0);
  });
});

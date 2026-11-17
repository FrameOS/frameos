// A store tile says where its scene is installed already (#871), by the same
// rule the install dialog greys a frame with: the origin every install stamps.
import { describe, expect, it } from "vitest";

import { framesWithScene } from "../../../../../../frontend/src/scenes/store/installedFrames";
import type { FrameType, RepositoryType, TemplateType } from "../../../../../../frontend/src/types";

const frame = (id: number, origins: Record<string, unknown>[]): FrameType =>
  ({
    id,
    name: `Frame ${id}`,
    scenes: origins.map((origin, index) => ({ id: `s${index}`, origin })),
  }) as unknown as FrameType;

const store = { id: "store", name: "Store" } as unknown as RepositoryType;

describe("framesWithScene", () => {
  it("finds a store scene by its store id on any frame", () => {
    const frames = [frame(1, [{ storeSceneId: "immich" }]), frame(2, []), frame(3, [{ storeSceneId: "clock" }])];
    const template = { name: "Immich", sceneId: "immich" } as TemplateType;
    expect(framesWithScene(frames, { template, repository: store })).toEqual([1]);
  });

  it("matches a repository template by repository and template id", () => {
    const frames = [
      frame(1, [{ repositoryId: "store", templateId: "t1" }]),
      frame(2, [{ repositoryId: "other", templateId: "t1" }]),
      frame(3, [{ templateId: "t1" }]),
    ];
    const template = { name: "T1", id: "t1" } as TemplateType;
    expect(framesWithScene(frames, { template, repository: store })).toEqual([1]);
    // A saved scene of this backend has no repository.
    expect(framesWithScene(frames, { template, repository: null })).toEqual([3]);
  });

  it("finds nothing on frames without the scene", () => {
    const template = { name: "Immich", sceneId: "immich" } as TemplateType;
    expect(framesWithScene([frame(1, [{}]), frame(2, [])], { template, repository: store })).toEqual([]);
  });
});

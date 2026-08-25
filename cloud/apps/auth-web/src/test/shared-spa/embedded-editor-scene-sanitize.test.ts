// @vitest-environment jsdom
//
// What the embedded editor does with the scenes a host page hands it. Store
// scenes published before node positions existed (word-clock v1 is a real
// one) carry nodes with no `position` at all, and reactflow reads
// node.position.x on every pass: the whole workspace died on "Cannot read
// properties of undefined (reading 'x')" — a runtime error page instead of a
// diagram. Every scene that goes in must come out laid out.

import { describe, expect, it } from "vitest";
import { sanitizeIncomingScenes } from "../../../../../../frontend/src/embed/sanitizeIncomingScenes";
import type { FrameType } from "../../../../../../frontend/src/types";

const frame: Partial<FrameType> = {
  height: 600,
  id: 1,
  interval: 300,
  mode: "rpios",
  rotate: 0,
  width: 800,
};

// A published scene from before the editor wrote positions: the nodes are
// otherwise complete, they simply have nowhere to be.
const positionlessScene = {
  edges: [{ id: "e1", source: "render-event", target: "svg-app" }],
  id: "word-clock",
  name: "Word clock",
  nodes: [
    { data: { keyword: "render" }, id: "render-event", type: "event" },
    { data: { config: {}, keyword: "svg" }, id: "svg-app", type: "app" },
    { data: { code: "1 + 1" }, id: "code", type: "code" },
  ],
};

describe("sanitizeIncomingScenes", () => {
  it("gives every node of a positionless scene somewhere to be", () => {
    const [scene] = sanitizeIncomingScenes([positionlessScene], frame);
    expect(scene?.nodes).toHaveLength(3);
    for (const node of scene?.nodes ?? []) {
      expect(Number.isFinite(node.position?.x)).toBe(true);
      expect(Number.isFinite(node.position?.y)).toBe(true);
    }
    // Laid out, not all piled on the origin — a scene with no positions at
    // all is arranged, which is what makes it readable on arrival.
    const spots = new Set(
      (scene?.nodes ?? []).map((node) => `${node.position.x},${node.position.y}`),
    );
    expect(spots.size).toBe(3);
  });

  it("keeps the positions a scene already has", () => {
    const placed = {
      ...positionlessScene,
      nodes: positionlessScene.nodes.map((node, index) => ({
        ...node,
        position: { x: index * 100, y: index * 50 },
      })),
    };
    const [scene] = sanitizeIncomingScenes([placed], frame);
    expect((scene?.nodes ?? []).map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 200, y: 100 },
    ]);
  });

  it("survives whatever a host page passes for scenes", () => {
    expect(sanitizeIncomingScenes(undefined, frame)).toEqual([]);
    expect(sanitizeIncomingScenes(null, frame)).toEqual([]);
    expect(sanitizeIncomingScenes("nope", frame)).toEqual([]);
    expect(sanitizeIncomingScenes([null, undefined], frame)).toEqual([]);
    // A scene object with nothing in it still becomes a usable scene.
    const [empty] = sanitizeIncomingScenes([{}], frame);
    expect(empty?.nodes).toEqual([]);
    expect(empty?.edges).toEqual([]);
    expect(empty?.id).toBeTruthy();
  });
});

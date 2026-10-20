import { describe, expect, it } from "vitest";
import type { FrameScene, LogType } from "../../../../../../frontend/src/types";
import { runtimeNodeErrorsByNodeId } from "../../../../../../frontend/src/utils/frameRuntimeErrors";

// The runtime numbers nodes in the order the frame's scenes list them and logs
// a node error under the scene's id: its own id from 2026.10.18, the legacy
// `uploaded/<id>` before that for a scene it was handed. Both must land on the
// editor's node.
const scenes = [
  { id: "a", name: "A", nodes: [{ id: "n1" }, { id: "n2" }], edges: [] },
  { id: "b", name: "B", nodes: [{ id: "n3" }], edges: [] },
] as unknown as FrameScene[];

let nextLogId = 1;
function errorLog(sceneId: string, nodeId: number): LogType {
  return {
    id: nextLogId++,
    timestamp: "2026-10-20T10:00:00Z",
    ip: "",
    type: "webhook",
    line: JSON.stringify({ event: "interpreter:node:error", sceneId, nodeId, message: "boom" }),
    frame_id: 1,
  } as unknown as LogType;
}

describe("runtimeNodeErrorsByNodeId", () => {
  it("maps a runtime node id to the editor's node under the scene's own id", () => {
    const errors = runtimeNodeErrorsByNodeId([errorLog("a", 2)], scenes, "a");
    expect(Object.keys(errors)).toEqual(["n2"]);
    expect(errors.n2?.message).toBe("boom");
  });

  it("does the same for an older runtime's legacy uploaded/ id", () => {
    const errors = runtimeNodeErrorsByNodeId([errorLog("uploaded/a", 1)], scenes, "a");
    expect(Object.keys(errors)).toEqual(["n1"]);
  });

  it("ignores errors from another scene", () => {
    expect(runtimeNodeErrorsByNodeId([errorLog("b", 3), errorLog("uploaded/b", 3)], scenes, "a")).toEqual({});
  });
});

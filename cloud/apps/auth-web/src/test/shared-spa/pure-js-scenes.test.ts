// @vitest-environment jsdom
//
// Pure JS scenes (settings.execution: "js", docs/pure-js-scenes.md) across
// the control planes: the shared SPA keeps the stamp and the sources through
// sanitizeScene on every frame mode, the deploy predicates count them as
// JSON deploys, the cloud validator accepts them without nodes, and the
// converter leaves them alone. The runtime side is pinned by
// frameos/src/frameos/tests/test_js_scene.nim.
import { describe, expect, it } from "vitest";
import { convertScene } from "@frameos-cloud/scene-convert";
import { sanitizeScene } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import {
  isJsSceneSourceName,
  jsSceneMainFile,
} from "../../../../../../frontend/src/scenes/workspace/jsSceneEditorLogic";
import {
  normalizeSceneExecution,
  sceneExecutionForFrame,
  sceneIsCompiledForFrame,
  sceneIsJs,
  sceneRunsFromJson,
} from "../../../../../../frontend/src/utils/sceneExecution";
import { buildSceneTypeDeclarations } from "../../../../../../frontend/src/utils/sceneTypeDeclarations";
import type { FrameScene } from "../../../../../../frontend/src/types";
import { validateScenePayload } from "../../lib/ai/scene-utils";

const jsScene = {
  id: "js-1",
  name: "Clock",
  settings: { execution: "js" as const, refreshInterval: 60 },
  fields: [{ name: "city", type: "string", value: "Brussels", access: "public" }],
  nodes: [],
  edges: [],
  sources: { "scene.ts": "export function render(scene, canvas) { canvas.clear('#fff') }", "lib.ts": "export const x = 1" },
} satisfies Partial<FrameScene>;

describe("pure JS scenes in the shared SPA", () => {
  it("sanitizeScene keeps the js stamp and the sources on a Pi and on an ESP32", () => {
    for (const mode of ["rpios", "embedded"] as const) {
      const scene = sanitizeScene(jsScene, { mode, interval: 300 });
      expect(scene.settings?.execution).toBe("js");
      expect(scene.sources).toEqual(jsScene.sources);
      expect(scene.nodes).toEqual([]);
      expect(scene.edges).toEqual([]);
    }
  });

  it("is a JSON deploy on every frame, never a compiled one", () => {
    expect(sceneIsJs(jsScene)).toBe(true);
    expect(normalizeSceneExecution(jsScene)).toBe("js");
    expect(sceneExecutionForFrame(jsScene, "rpios")).toBe("js");
    expect(sceneExecutionForFrame(jsScene, "embedded")).toBe("js");
    expect(sceneIsCompiledForFrame(jsScene, "rpios")).toBe(false);
    expect(sceneRunsFromJson(jsScene)).toBe(true);
    expect(sceneRunsFromJson({ settings: { execution: "compiled" } })).toBe(false);
    expect(sceneRunsFromJson({ settings: { execution: "interpreted" } })).toBe(true);
  });

  it("names the entry module and refuses file names the frame's loader would not resolve", () => {
    expect(jsSceneMainFile({ "lib.ts": "", "scene.ts": "" })).toBe("scene.ts");
    expect(jsSceneMainFile({ "scene.tsx": "" })).toBe("scene.tsx");
    expect(jsSceneMainFile({})).toBe("scene.ts");
    expect(isJsSceneSourceName("icons.ts")).toBe(true);
    expect(isJsSceneSourceName("lib/util.tsx")).toBe(true);
    expect(isJsSceneSourceName("data.json")).toBe(true);
    expect(isJsSceneSourceName("../escape.ts")).toBe(false);
    expect(isJsSceneSourceName("/abs.ts")).toBe(false);
    expect(isJsSceneSourceName("notes.md")).toBe(false);
  });

  it("types scene.state from the scene's own fields", () => {
    const declarations = buildSceneTypeDeclarations([
      { name: "city", type: "string", value: "Brussels" },
      { name: "mode", type: "select", options: ["day", "night"], value: "day" },
    ] as never);
    expect(declarations).toContain('declare module "frameos"');
    expect(declarations).toContain("city: string;");
    expect(declarations).toContain('mode: "day" | "night";');
    expect(declarations).toContain("cell(x: number, y: number, width: number, height: number): Canvas;");
  });
});

describe("pure JS scenes on the cloud", () => {
  it("validateScenePayload accepts a node-less js scene and wants its scene.ts", () => {
    expect(validateScenePayload({ scenes: [jsScene] })).toEqual([]);
    expect(validateScenePayload({ scenes: [{ ...jsScene, sources: { "lib.ts": "" } }] })).toEqual([
      "Scene 0 is a pure JS scene but has no scene.ts in sources.",
    ]);
    expect(
      validateScenePayload({ scenes: [{ ...jsScene, nodes: [{ id: "n", type: "event", data: { keyword: "render" } }] }] }),
    ).toEqual(["Scene 0 is a pure JS scene and must not carry nodes."]);
    // A graph scene still needs its nodes.
    expect(validateScenePayload({ scenes: [{ ...jsScene, settings: { execution: "interpreted" } }] })).toContain(
      "Scene 0 must include nodes.",
    );
  });

  it("the converter leaves a js scene stamped js", async () => {
    const { scene, report } = await convertScene(JSON.parse(JSON.stringify(jsScene)));
    expect(scene.settings?.execution).toBe("js");
    expect(report.executionAfter).toBe("js");
    expect(report.executionBefore).toBe("js");
  });
});

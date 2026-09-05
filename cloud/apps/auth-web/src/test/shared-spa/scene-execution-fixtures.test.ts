// @vitest-environment jsdom
//
// The scene-execution conformance corpus (docs/scene-execution-fixtures.json)
// against every TypeScript implementation of the rule: the shared SPA's
// sceneRequiresCompilation / sceneExecutionForFrame / normalizeFrameCompilationMode,
// the converter package's sceneRequiresCompilation, and the cloud store's
// compiledSceneNames (what the store refuses at publish and at assign).
// backend/app/utils/tests/test_scene_execution_fixtures.py runs the same JSON
// against the Python side, so drift between the planes is a failing test.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sceneRequiresCompilation as converterRequiresCompilation } from "@frameos-cloud/scene-convert";
import { sceneRequiresCompilation } from "../../../../../../frontend/src/utils/sceneApps";
import {
  normalizeSceneExecution,
  sceneExecutionForFrame,
  sceneIsCompiledForFrame,
} from "../../../../../../frontend/src/utils/sceneExecution";
import { normalizeFrameCompilationMode } from "../../../../../../frontend/src/utils/frameBuildOptions";
import { frameCompilationMode } from "../../../../../../frontend/src/scenes/frame/frameDeployUtils";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";
import { compiledSceneNames } from "../../lib/store";

interface SceneCase {
  name: string;
  scene: Record<string, unknown> & { id: string; name: string };
  requiresCompilation: boolean;
  execution: "compiled" | "interpreted";
  cloudRefuses: boolean;
}

interface FrameCase {
  name: string;
  frame: Record<string, unknown>;
  compilationMode: "static" | "precompiled";
}

const corpus = JSON.parse(
  // process.cwd() rather than import.meta.url: under jsdom the module URL is
  // http://, and vitest runs from the package directory (cloud/apps/auth-web).
  readFileSync(resolve(process.cwd(), "../../../docs/scene-execution-fixtures.json"), "utf8"),
) as { scenes: SceneCase[]; frames: FrameCase[] };

describe("scene-execution fixtures", () => {
  it("has a corpus worth running", () => {
    expect(corpus.scenes.length).toBeGreaterThanOrEqual(15);
    expect(corpus.frames.length).toBeGreaterThanOrEqual(8);
  });

  for (const testCase of corpus.scenes) {
    it(`scene: ${testCase.name}`, () => {
      const scene = testCase.scene as unknown as Partial<FrameScene>;
      // The shared SPA (self-hosted backend and cloud workspace).
      expect(sceneRequiresCompilation(scene)).toBe(testCase.requiresCompilation);
      expect(sceneExecutionForFrame(scene, "rpios")).toBe(testCase.execution);
      expect(sceneIsCompiledForFrame(scene, "rpios")).toBe(testCase.execution === "compiled");
      expect(normalizeSceneExecution(scene)).toBe(testCase.execution);
      // An embedded (ESP32) frame runs everything interpreted regardless.
      expect(sceneExecutionForFrame(scene, "embedded")).toBe("interpreted");
      // The converter package (the /nim-converter page, the CLI, MCP).
      expect(converterRequiresCompilation(testCase.scene as never)).toBe(testCase.requiresCompilation);
      // The cloud store's refusal list.
      const refused = compiledSceneNames([testCase.scene]);
      expect(refused).toEqual(testCase.cloudRefuses ? [testCase.scene.name] : []);
    });
  }

  for (const testCase of corpus.frames) {
    it(`frame: ${testCase.name}`, () => {
      const frame = testCase.frame as Partial<FrameType>;
      expect(frameCompilationMode(frame)).toBe(testCase.compilationMode);
      const block = frame.mode === "buildroot" ? frame.buildroot : frame.rpios;
      expect(normalizeFrameCompilationMode(block?.compilationMode)).toBe(testCase.compilationMode);
    });
  }
});

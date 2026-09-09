// @vitest-environment jsdom
//
// Pure editor helpers from the 2026-09 review: every export path stripped
// of `secret: true` field values, fresh node ids on a scene copy, duplicate
// state-field codenames refused, and inline Nim validation that never runs
// on a surface without the backend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, DiagramNode, FrameScene } from "../../../../../../frontend/src/types";
import {
  stripSecretFieldValues,
  stripSecretNodeConfig,
} from "../../../../../../frontend/src/utils/stripSecretFieldValues";
import { duplicateScenes, remapNodeIds } from "../../../../../../frontend/src/utils/duplicateScenes";
import { frameFormSceneErrors } from "../../../../../../frontend/src/scenes/frame/frameFormSceneErrors";
import {
  canValidateNimSource,
  isNimSourceFile,
  validateNimSource,
} from "../../../../../../frontend/src/utils/validateNimSource";

const catalog: Record<string, AppConfig> = {
  "data/weather": {
    name: "Weather",
    fields: [
      { name: "apiKey", label: "API key", type: "string", secret: true },
      { name: "city", label: "City", type: "string" },
    ],
  } as unknown as AppConfig,
};

const appNode = {
  id: "n1",
  type: "app",
  position: { x: 0, y: 0 },
  data: { keyword: "data/weather", config: { apiKey: "sk-live", city: "Brussels" } },
} as unknown as DiagramNode;

const scene = {
  id: "s1",
  name: "S",
  nodes: [appNode, { id: "n2", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } }],
  edges: [{ id: "e1", source: "n2", target: "n1", sourceHandle: "next", targetHandle: "prev" }],
  fields: [],
  customEvents: [],
} as unknown as FrameScene;

describe("stripSecretFieldValues", () => {
  it("drops secret config values and keeps the rest", () => {
    const stripped = stripSecretFieldValues(scene, catalog);
    const node = stripped.nodes[0]!.data as { config: Record<string, unknown> };
    expect(node.config).toEqual({ city: "Brussels" });
    // Untouched input.
    expect((scene.nodes[0]!.data as { config: Record<string, unknown> }).config.apiKey).toBe("sk-live");
    // Nothing to strip: same reference.
    expect(stripSecretFieldValues(stripped, catalog)).toBe(stripped);
  });

  it("reads a source node's own config.json", () => {
    const source = {
      id: "src",
      type: "source",
      position: { x: 0, y: 0 },
      data: {
        keyword: "custom",
        config: { token: "t", name: "x" },
        sources: { "config.json": JSON.stringify({ fields: [{ name: "token", type: "string", secret: true }] }) },
      },
    } as unknown as DiagramNode;
    const node = stripSecretNodeConfig(source, {}).data as { config: Record<string, unknown> };
    expect(node.config).toEqual({ name: "x" });
  });
});

describe("duplicateScenes", () => {
  it("gives the copy fresh node and edge ids with edges rewired", () => {
    const [copy] = duplicateScenes([scene]);
    expect(copy!.id).not.toBe(scene.id);
    const ids = copy!.nodes.map((node) => node.id);
    expect(ids).not.toContain("n1");
    expect(ids).not.toContain("n2");
    expect(copy!.edges[0]!.id).not.toBe("e1");
    expect(ids).toContain(copy!.edges[0]!.source);
    expect(ids).toContain(copy!.edges[0]!.target);
  });

  it("remapNodeIds keeps an edge to an unknown node as-is", () => {
    const out = remapNodeIds({ ...scene, edges: [{ id: "e9", source: "n1", target: "ghost" }] } as FrameScene);
    expect(out.edges[0]!.target).toBe("ghost");
    expect(out.edges[0]!.source).toBe(out.nodes[0]!.id);
  });
});

describe("frameFormSceneErrors", () => {
  it("refuses duplicate state-field codenames (trimmed)", () => {
    const [errors] = frameFormSceneErrors([
      {
        fields: [
          { name: "city", type: "string" },
          { name: " city ", type: "string" },
          { name: "other", type: "string" },
        ],
      } as Partial<FrameScene>,
    ]);
    expect(errors!.fields.map((field: { name: string }) => field.name)).toEqual(["", "Codename must be unique", ""]);
  });
});

describe("validateNimSource", () => {
  const fetchMock = vi.fn<typeof fetch>();
  type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean; FRAMEOS_APP_CONFIG?: { cloudMode?: boolean } };
  const testWindow = window as TestWindow;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
    delete testWindow.FRAMEOS_APP_CONFIG;
  });

  it("only validates .nim files", () => {
    expect(isNimSourceFile("app.nim")).toBe(true);
    expect(isNimSourceFile("README.md")).toBe(false);
    expect(isNimSourceFile("config.json")).toBe(false);
    expect(isNimSourceFile("app.ts")).toBe(false);
  });

  it("never posts from the embedded editor or the cloud", async () => {
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    expect(canValidateNimSource()).toBe(false);
    expect(await validateNimSource("app.nim", "echo 1")).toBeNull();
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    expect(canValidateNimSource()).toBe(false);
    expect(await validateNimSource("app.nim", "echo 1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears on a failed request and keeps well-formed errors", async () => {
    // apiFetch scopes backend calls to a project (one /api/projects lookup,
    // cached for the module); everything else is the validation itself.
    const validations: Response[] = [
      new Response("nope", { status: 500 }),
      Response.json({ errors: [{ line: 1, column: 2, error: "boom" }, { junk: true }] }),
    ];
    fetchMock.mockImplementation(async (input) => {
      // Project-scoped: /api/projects/1/api/apps/validate_source.
      if (String(input).includes("validate_source")) {
        return validations.shift()!;
      }
      if (String(input).includes("/api/projects")) {
        return Response.json({ projects: [{ id: 1 }] });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    expect(await validateNimSource("app.nim", "echo 1")).toBeNull();
    expect(await validateNimSource("app.nim", "echo 1")).toEqual([{ line: 1, column: 2, error: "boom" }]);
    expect(validations).toHaveLength(0);
  });
});

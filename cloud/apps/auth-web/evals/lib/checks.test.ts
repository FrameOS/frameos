import { describe, expect, it } from "vitest";
import { runCheck, type CheckInput } from "./checks";
import type { Check } from "./types";

// The eval header's rule: checks are about the REQUEST, not one
// implementation. "Analog clock drawn as SVG" used to demand the render/svg
// app, while the prompt's JS app contract tells the agent to return
// frameos.svg(...) from a scene-local app into render/image — so two cases
// scored 5/5 with the judge and failed (2026-09-20).

const event = { data: { keyword: "render" }, id: "e1", type: "event" };
const renderImage = { data: { config: {}, keyword: "render/image" }, id: "img", type: "app" };

function jsAppScene(source: string) {
  return {
    apps: { stationClock: { sources: { "app.ts": source, "config.json": "{}" } } },
    nodes: [event, { data: { config: {}, keyword: "stationClock" }, id: "clock", type: "app" }, renderImage],
  };
}

function run(check: Check, scenes: unknown[]) {
  const input: CheckInput = {
    deliveredTool: "build_scene",
    judge: null,
    lint: null,
    render: null,
    reply: "",
    scenes,
    seedScene: null,
  };
  return runCheck(check, input);
}

describe("draws_svg", () => {
  it("passes for a scene-local JS app returning frameos.svg(...) into render/image", () => {
    const result = run({ type: "draws_svg" }, [jsAppScene("export function get(app) { return frameos.svg(parts.join('')) }")]);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("stationClock (app.ts)");
  });

  it("passes for the render/svg app, the jsSvg template and a code node building <svg", () => {
    const renderSvg = { nodes: [event, { data: { config: {}, keyword: "render/svg" }, id: "svg", type: "app" }] };
    expect(run({ type: "draws_svg" }, [renderSvg]).passed).toBe(true);

    const template = {
      apps: { dots: { origin: "repo/apps/text/jsSvg", sources: { "app.ts": "export const get = () => null" } } },
      nodes: [event, { data: { config: {}, keyword: "dots" }, id: "dots", type: "app" }],
    };
    expect(run({ type: "draws_svg" }, [template]).passed).toBe(true);

    const codeNode = { nodes: [event, { data: { codeJS: "`<svg viewBox=\"0 0 10 10\"></svg>`" }, id: "c1", type: "code" }] };
    expect(run({ type: "draws_svg" }, [codeNode]).detail).toContain("code node c1");
  });

  it("fails when nothing draws SVG, unless an accepted alternative app is used", () => {
    const textOnly = { nodes: [event, { data: { config: {}, keyword: "render/text" }, id: "t", type: "app" }] };
    const failed = run({ type: "draws_svg" }, [textOnly]);
    expect(failed.passed).toBe(false);
    expect(failed.detail).toContain("has: render/text");
    expect(run({ orApps: ["render/text"], type: "draws_svg" }, [textOnly]).passed).toBe(true);
    // A JS app that draws nothing is not SVG just for being a JS app.
    expect(run({ type: "draws_svg" }, [jsAppScene("export function get() { return 'hello' }")]).passed).toBe(false);
  });

  it("ignores an unused apps entry: only app NODES count", () => {
    const unused = { apps: { ghost: { sources: { "app.ts": "frameos.svg('')" } } }, nodes: [event, renderImage] };
    expect(run({ type: "draws_svg" }, [unused]).passed).toBe(false);
  });
});

describe("code_nodes_min", () => {
  it("counts scene-local JS app nodes as code, next to code nodes", () => {
    const result = run({ min: 1, type: "code_nodes_min" }, [jsAppScene("export function get() { return 1 }")]);
    expect(result.passed).toBe(true);
    expect(result.detail).toBe("0 code nodes + 1 scene-local JS apps");
  });

  it("does not count catalog apps", () => {
    const result = run({ min: 1, type: "code_nodes_min" }, [{ nodes: [event, renderImage] }]);
    expect(result.passed).toBe(false);
  });
});

describe("flow_sets_state", () => {
  const buttonScene = (nodes: unknown[], apps: Record<string, unknown> = {}) => ({
    apps,
    edges: [
      { id: "b1", source: "button", sourceHandle: "next", target: "act", targetHandle: "prev", type: "appNodeEdge" },
      { id: "b2", source: "act", sourceHandle: "next", target: "redraw", targetHandle: "prev", type: "appNodeEdge" },
    ],
    nodes: [
      event,
      { data: { keyword: "button" }, id: "button", type: "event" },
      ...nodes,
      { data: { config: {}, keyword: "render" }, id: "redraw", type: "dispatch" },
    ],
  });
  const toggleApp = (source: string) => ({ toggle: { sources: { "app.ts": source, "config.json": "{}" } } });
  const toggleNode = { data: { config: {}, keyword: "toggle" }, id: "act", type: "app" };

  it("passes for a run() app that sets state and for logic/setAsState", () => {
    const viaRun = run({ event: "button", type: "flow_sets_state" }, [
      buttonScene([toggleNode], toggleApp("export function run(app) { frameos.setState('unit', 'f') }")),
    ]);
    expect(viaRun.passed).toBe(true);
    expect(viaRun.detail).toContain("scene app toggle (act)");
    const viaApp = run({ event: "button", type: "flow_sets_state" }, [
      buttonScene([{ data: { config: { stateKey: "unit" }, keyword: "logic/setAsState" }, id: "act", type: "app" }]),
    ]);
    expect(viaApp.passed).toBe(true);
  });

  it("fails for the get()-only app the frame never calls in a flow", () => {
    const result = run({ event: "button", type: "flow_sets_state" }, [
      buttonScene([toggleNode], toggleApp("export function get(app) { frameos.setState('unit', 'f'); return null }")),
    ]);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("toggle (act, no run())");
  });

  it("fails without a button event node or without a state change", () => {
    expect(run({ event: "button", type: "flow_sets_state" }, [{ nodes: [event, renderImage] }]).detail).toBe(
      'no "button" event node',
    );
    const redrawOnly = run({ event: "button", type: "flow_sets_state" }, [
      buttonScene([{ data: { config: {}, keyword: "render" }, id: "act", type: "dispatch" }]),
    ]);
    expect(redrawOnly.passed).toBe(false);
  });
});

describe("tool_called", () => {
  const input = (toolCalls?: string[]): CheckInput => ({
    deliveredTool: "modify_scene",
    judge: null,
    lint: null,
    render: null,
    reply: "",
    scenes: [],
    seedScene: null,
    ...(toolCalls ? { toolCalls } : {}),
  });

  it("passes when the agent called the tool in any turn", () => {
    expect(runCheck({ name: "render_scene", type: "tool_called" }, input(["get_app", "render_scene"])).passed).toBe(true);
  });

  it("names the tools it did call when it fails", () => {
    const result = runCheck({ name: "render_scene", type: "tool_called" }, input(["patch_scene"]));
    expect(result.passed).toBe(false);
    expect(result.detail).toBe("render_scene never called (tools: patch_scene)");
    expect(runCheck({ name: "render_scene", type: "tool_called" }, input()).detail).toBe(
      "render_scene never called (tools: none)",
    );
  });
});

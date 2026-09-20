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
      apps: { dots: { origin: "repo/apps/code/jsSvg", sources: { "app.ts": "export const get = () => null" } } },
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

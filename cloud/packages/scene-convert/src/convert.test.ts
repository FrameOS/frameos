import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { convertScene, describeReport, sceneRequiresCompilation } from "./convert";
import type { ModelPort, ModelRequest } from "./model";
import type { Scene, SceneEdge, SceneNode } from "./types";

const fixturesDir = path.join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): Scene {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as Scene;
}

const heatTimerTs = `export function run(app: FrameOSApp, context: FrameOSContext): void {
  const heating = app.state.water_heater?.state === 'heat'
  let heatStart = Number(app.state.heatStart ?? 0)
  if (heating && heatStart === 0) { heatStart = Date.now() / 1000; frameos.setState('heatStart', heatStart) }
  if (!heating && heatStart !== 0) { heatStart = 0; frameos.setState('heatStart', 0) }
  if (heatStart === 0) { frameos.setState('heatTimer', ''); return }
  const left = 30 * 60 - (Date.now() / 1000 - heatStart)
  if (left < 0) { frameos.setState('heatTimer', 'Still HOT'); return }
  const m = Math.trunc(left / 60), s = Math.trunc(left) % 60
  frameos.setState('heatTimer', \`\${m < 10 ? '0' : ''}\${m}:\${s < 10 ? '0' : ''}\${s}\`)
}
`;

const usage = { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 };

/** A model that answers every request from a script, recording what it was asked. */
function fakeModel(answers: (request: ModelRequest, call: number) => unknown): ModelPort & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const port = vi.fn(async (request: ModelRequest) => {
    requests.push(request);
    const args = answers(request, requests.length);
    return { arguments: args, model: "fake-model", text: "", usage };
  }) as unknown as ModelPort & { requests: ModelRequest[] };
  port.requests = requests;
  return port;
}

function node(scene: Scene, prefix: string): SceneNode {
  const found = scene.nodes?.find((entry) => entry.id.startsWith(prefix));
  if (!found) {
    throw new Error(`no node ${prefix}`);
  }
  return found;
}

function edgesInto(scene: Scene, nodeId: string): SceneEdge[] {
  return (scene.edges ?? []).filter((edge) => edge.target === nodeId);
}

describe("vannituba — fixture #1", () => {
  it("is a compiled scene before conversion", () => {
    expect(sceneRequiresCompilation(fixture("vannituba.json"))).toBe(true);
  });

  it("converts every code node without the model and the app with one call", async () => {
    const model = fakeModel(() => ({
      files: { "app.ts": heatTimerTs },
      notes: "Ported run() to app.state / frameos.setState.",
    }));
    const now = () => new Date("2026-08-30T12:00:00Z");
    const { scene, report } = await convertScene(fixture("vannituba.json"), { model, modelName: "fake-model", now, tool: "test" });

    // Pass 1 got all five code nodes; only the app went to the model.
    expect(report.modelCalls).toBe(1);
    const converted = report.items.filter((item) => item.kind === "code" && item.status === "converted");
    expect(converted).toHaveLength(5);
    expect(converted.every((item) => item.status === "converted" && item.via === "deterministic")).toBe(true);

    expect(node(scene, "37255a86").data?.codeJS).toBe('String(state.water_heater?.state ?? "")');
    expect(node(scene, "5bf6d3cd").data?.codeJS).toBe('String(state.heatTimer ?? "")');
    expect(node(scene, "2d164791").data?.codeJS).toBe('stateValue === "heat"');
    expect(node(scene, "91949e79").data?.codeJS).toBe('stateValue === "heat"');
    expect(node(scene, "964cf503").data?.codeJS).toBe('stateValue === "heat" ? -40 : 0');
    // The Nim is gone: a converted scene carries none.
    expect(node(scene, "964cf503").data?.code).toBeUndefined();
    expect(scene.nodes?.every((entry) => entry.type !== "code" || entry.data?.code === undefined)).toBe(true);

    // The reserved `state` argument was renamed, and its edges follow.
    for (const id of ["2d164791", "91949e79", "964cf503"]) {
      const target = node(scene, id);
      expect(target.data?.codeArgs).toEqual([{ name: "stateValue", type: "string" }]);
      const inbound = edgesInto(scene, target.id);
      expect(inbound).toHaveLength(1);
      expect(inbound[0]?.targetHandle).toBe("codeField/stateValue");
    }
    const renamed = report.items.filter((item) => item.kind === "arg");
    expect(renamed).toHaveLength(3);

    // The stale codeField/arg + codeArg/arg edges (no such argument, never referenced) are gone.
    const dropped = report.items.filter((item) => item.kind === "edge" && item.status === "dropped");
    expect(dropped).toHaveLength(4);
    expect((scene.edges ?? []).some((edge) => edge.targetHandle?.endsWith("/arg"))).toBe(false);

    // The app: JS sibling next to the Nim, category logic, config kept.
    const app = node(scene, "dfacd0d4");
    const sources = app.data?.sources as Record<string, string>;
    expect(sources["app.ts"]).toBe(heatTimerTs);
    expect(sources["app.nim"]).toBeUndefined();
    expect(Object.keys(sources).sort()).toEqual(["app.ts", "config.json"]);
    const config = JSON.parse(sources["config.json"]!) as { category: string; name: string };
    expect(config.category).toBe("logic");
    expect(config.name).toBe("Heat timer");
    const appItem = report.items.find((item) => item.kind === "app");
    expect(appItem).toMatchObject({ attempts: 1, category: "logic", files: ["app.ts"], status: "converted", via: "model" });

    // The model was told the wiring and shown the sources.
    expect(model.requests[0]?.input).toContain("after logic/setAsState before logic/ifElse");
    expect(model.requests[0]?.input).toContain("export function run(app, context)");
    expect(model.requests[0]?.input).toContain("--- app.nim ---");
    expect(model.requests[0]?.input).toContain("heatTimer (code node)");
    expect(model.requests[0]?.instructions).toContain("frameos.setState");

    // Fully interpreted, and it says where it came from.
    expect(sceneRequiresCompilation(scene)).toBe(false);
    expect(scene.settings?.execution).toBe("interpreted");
    expect(scene.settings?.convertedFrom).toEqual({
      at: "2026-08-30T12:00:00.000Z",
      execution: "compiled",
      model: "fake-model",
      tool: "test",
    });
    expect(report.executionBefore).toBe("compiled");
    expect(report.executionAfter).toBe("interpreted");
    expect(report.needsModel).toEqual([]);
    expect(report.needsManualPort).toEqual([]);
    expect(report.usage).toEqual(usage);
    // Nothing else about the scene moved.
    expect(scene.nodes).toHaveLength(fixture("vannituba.json").nodes!.length);
    expect(appItem && appItem.kind === "app" && appItem.status === "converted" ? appItem.insertedRenderImageNodeId : "x").toBeUndefined();
    expect(scene.fields).toEqual(fixture("vannituba.json").fields);
  });

  it("without a model, converts the code nodes and reports the app as needing it", async () => {
    const { scene, report } = await convertScene(fixture("vannituba.json"));
    expect(report.modelCalls).toBe(0);
    expect(report.needsModel).toEqual(["dfacd0d4-cb93-4119-ac69-e4f2059add27"]);
    expect(report.executionAfter).toBe("compiled");
    expect(scene.settings?.execution).toBe("compiled");
    expect(scene.settings?.convertedFrom).toBeUndefined();
    // …but the code nodes did get their JavaScript, so a second run has less to do.
    expect(node(scene, "964cf503").data?.codeJS).toBe('stateValue === "heat" ? -40 : 0');
    const lines = describeReport(report);
    expect(lines.some((line) => line.includes('app "Heat timer": needs model'))).toBe(true);
    expect(lines.at(-1)).toContain("execution: compiled → compiled");
  });

  it("is idempotent: converting the converted scene changes nothing", async () => {
    const model = fakeModel(() => ({ files: { "app.ts": heatTimerTs }, notes: "" }));
    const first = await convertScene(fixture("vannituba.json"), { model, now: () => new Date(0) });
    const again = await convertScene(first.scene, { model, now: () => new Date(0) });
    expect(again.report.modelCalls).toBe(0);
    expect(again.scene).toEqual(first.scene);
    // Nothing left to touch: the first run removed every trace of Nim.
    expect(again.report.items).toEqual([]);
  });

  it("marks the app for a manual port when the model says it cannot", async () => {
    const model = fakeModel(() => ({ notes: "", unsupported: "It shells out to a script." }));
    const { scene, report } = await convertScene(fixture("vannituba.json"), { model, now: () => new Date(0) });
    expect(report.needsManualPort).toEqual(["dfacd0d4-cb93-4119-ac69-e4f2059add27"]);
    expect(node(scene, "dfacd0d4").data?.needsConversion).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      reason: "It shells out to a script.",
      source: "app.nim",
    });
    expect(scene.settings?.execution).toBe("compiled");
    // Nothing replaced the Nim, so it stays — the scene still says what is missing.
    expect((node(scene, "dfacd0d4").data?.sources as Record<string, string>)["app.ts"]).toBeUndefined();
    expect((node(scene, "dfacd0d4").data?.sources as Record<string, string>)["app.nim"]).toContain("proc run*");
  });

  it("feeds lint problems back and accepts the corrected attempt", async () => {
    const model = fakeModel((request, call) =>
      call === 1
        ? { files: { "app.ts": "export function get() { return 1 }" }, notes: "" }
        : { files: { "app.ts": heatTimerTs }, notes: `fixed: ${request.input.includes("must `export function run") ? "yes" : "no"}` },
    );
    const { report } = await convertScene(fixture("vannituba.json"), { model });
    expect(report.modelCalls).toBe(2);
    expect(model.requests[1]?.input).toContain("The previous attempt was rejected");
    expect(model.requests[1]?.input).toContain("export function run(app, context)");
    expect(report.items.find((item) => item.kind === "app")).toMatchObject({ attempts: 2, status: "converted" });
  });

  it("gives up after maxAttempts and keeps the scene compiled", async () => {
    const model = fakeModel(() => ({ files: { "app.ts": "const x = 1" }, notes: "" }));
    const { report } = await convertScene(fixture("vannituba.json"), { maxAttempts: 2, model });
    expect(report.modelCalls).toBe(2);
    expect(report.needsManualPort).toHaveLength(1);
    expect(report.items.find((item) => item.kind === "app")).toMatchObject({ status: "needs_manual_port" });
  });

  it("treats a missing tool call as a failed attempt", async () => {
    const model = fakeModel((_request, call) => (call === 1 ? undefined : { files: { "app.ts": heatTimerTs }, notes: "" }));
    const { report } = await convertScene(fixture("vannituba.json"), { model });
    expect(report.modelCalls).toBe(2);
    expect(model.requests[1]?.input).toContain("no deliver_conversion call was made");
    expect(report.executionAfter).toBe("interpreted");
  });
});

describe("dataCodeFloat — fixture #0", () => {
  it("converts the one Nim-only code node and leaves the JS one alone", async () => {
    const { scene, report } = await convertScene(fixture("dataCodeFloat.json"), { now: () => new Date(0) });
    expect(report.modelCalls).toBe(0);
    expect(node(scene, "3849fd98").data?.codeJS).toBe("arg + 50.0");
    expect(node(scene, "3849fd98").data?.code).toBeUndefined();
    // Already JavaScript, but still carrying its old Nim: cleaned too.
    expect(node(scene, "624b8ce0").data?.codeJS).toBe("50.0");
    expect(node(scene, "624b8ce0").data?.code).toBeUndefined();
    expect(report.items.find((item) => item.kind === "code" && item.nodeId.startsWith("624b8ce0"))).toMatchObject({ status: "already_javascript" });
    expect(report.executionBefore).toBe("compiled");
    expect(scene.settings?.execution).toBe("interpreted");
    expect(scene.settings?.convertedFrom).toMatchObject({ execution: "compiled" });
  });
});

describe("edge cases", () => {
  const renderEvent: SceneNode = { data: { keyword: "render" }, id: "e1", position: { x: 0, y: 0 }, type: "event" };

  it("refuses source nodes", async () => {
    const scene: Scene = {
      edges: [],
      id: "s1",
      nodes: [renderEvent, { data: { source: "proc foo() = discard" }, id: "src1", type: "source" }],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene);
    expect(report.needsManualPort).toEqual(["src1"]);
    expect(out.nodes?.[1]?.data?.needsConversion).toMatchObject({ source: "source" });
    expect(out.settings?.execution).toBe("compiled");
  });

  it("declares an undeclared but used argument from its feeding edge", async () => {
    const scene: Scene = {
      edges: [
        { id: "x1", source: "c0", sourceHandle: "fieldOutput", target: "c1", targetHandle: "codeArg/count", type: "codeNodeEdge" },
        { id: "x2", source: "c0", sourceHandle: "fieldOutput", target: "c1", targetHandle: "codeField/unused", type: "codeNodeEdge" },
      ],
      id: "s1",
      nodes: [
        renderEvent,
        { data: { code: "1.5", codeArgs: [], codeOutputs: [{ name: "count", type: "float" }] }, id: "c0", type: "code" },
        { data: { code: "count * 2", codeArgs: [], codeOutputs: [{ name: "double", type: "float" }] }, id: "c1", type: "code" },
      ],
      settings: {},
    };
    const { scene: out, report } = await convertScene(scene);
    expect(out.nodes?.[2]?.data?.codeArgs).toEqual([{ name: "count", type: "float" }]);
    expect(out.nodes?.[2]?.data?.codeJS).toBe("count * 2");
    expect(out.edges).toEqual([
      { id: "x1", source: "c0", sourceHandle: "fieldOutput", target: "c1", targetHandle: "codeField/count", type: "codeNodeEdge" },
    ]);
    expect(report.items.filter((item) => item.kind === "edge").map((item) => item.status)).toEqual(["declared", "rewritten", "dropped"]);
    expect(report.executionBefore).toBe("compiled");
    expect(out.settings?.execution).toBe("interpreted");
  });

  it("keeps a reserved rename unique", async () => {
    const scene: Scene = {
      edges: [],
      id: "s1",
      nodes: [
        renderEvent,
        {
          data: {
            code: "now & format",
            codeArgs: [{ name: "now", type: "string" }, { name: "nowValue", type: "string" }, { name: "format", type: "string" }],
            codeOutputs: [{ name: "out", type: "string" }],
          },
          id: "c1",
          type: "code",
        },
      ],
      settings: { execution: "compiled" },
    };
    const { scene: out } = await convertScene(scene);
    expect(out.nodes?.[1]?.data?.codeArgs).toEqual([
      { name: "nowValue2", type: "string" },
      { name: "nowValue", type: "string" },
      { name: "formatValue", type: "string" },
    ]);
    expect(out.nodes?.[1]?.data?.codeJS).toBe("nowValue2 + formatValue");
  });

  it("sends a code node the grammar rejects to the model, with its renamed arguments", async () => {
    const model = fakeModel(() => ({ codeJS: "stateValue.split(',').length", notes: "" }));
    const scene: Scene = {
      edges: [{ id: "x1", source: "c0", sourceHandle: "fieldOutput", target: "c1", targetHandle: "codeField/state", type: "codeNodeEdge" }],
      id: "s1",
      nodes: [
        renderEvent,
        { data: { code: '"a,b"', codeArgs: [], codeOutputs: [{ name: "state", type: "string" }] }, id: "c0", type: "code" },
        { data: { code: "state.split(',').high + 1", codeArgs: [{ name: "state", type: "string" }], codeOutputs: [{ name: "n", type: "float" }] }, id: "c1", type: "code" },
      ],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene, { model });
    expect(report.modelCalls).toBe(1);
    expect(model.requests[0]?.input).toContain("- stateValue: string (fed by code node c0)");
    expect(model.requests[0]?.input).toContain("Pass 1 could not");
    expect(out.nodes?.[2]?.data?.codeJS).toBe("stateValue.split(',').length");
    expect(out.edges?.[0]?.targetHandle).toBe("codeField/stateValue");
    expect(report.items.find((item) => item.kind === "code" && item.nodeId === "c1")).toMatchObject({ status: "converted", via: "model" });
    expect(out.settings?.execution).toBe("interpreted");
  });

  it("rejects a code node the model answers with a statement, then accepts the expression", async () => {
    const model = fakeModel((_request, call) => (call === 1 ? { codeJS: "const y = x; y", notes: "" } : { codeJS: "x", notes: "" }));
    const scene: Scene = {
      edges: [],
      id: "s1",
      nodes: [renderEvent, { data: { code: "x.weird", codeArgs: [{ name: "x", type: "string" }], codeOutputs: [{ name: "y", type: "string" }] }, id: "c1", type: "code" }],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene, { model });
    expect(report.modelCalls).toBe(2);
    expect(model.requests[1]?.input).toContain("ONE expression");
    expect(out.nodes?.[1]?.data?.codeJS).toBe("x");
  });

  it("turns a Nim render app into a data app and wires a render/image node into its slot", async () => {
    const nim = `import pixie\nproc render*(self: App, context: ExecutionContext, image: Image) =\n  image.fill(rgb(255, 0, 0))\n`;
    const model = fakeModel(() => ({
      files: {
        "app.ts": 'export function get(app) { return frameos.svg(`<svg viewBox="0 0 ${app.frame.width} ${app.frame.height}"><rect width="100%" height="100%" fill="#ff0000"/></svg>`) }',
      },
      notes: "",
    }));
    const scene: Scene = {
      apps: {
        redFill: { name: "Red fill", sources: { "app.nim": nim, "config.json": JSON.stringify({ category: "render", fields: [], name: "Red fill" }) } },
      },
      edges: [
        { id: "e-1", source: "e1", sourceHandle: "next", target: "a1", targetHandle: "prev", type: "appNodeEdge" },
        { id: "e-2", source: "a1", sourceHandle: "next", target: "t1", targetHandle: "prev", type: "appNodeEdge" },
      ],
      id: "s1",
      nodes: [
        renderEvent,
        { data: { config: {}, keyword: "redFill" }, id: "a1", position: { x: 100, y: 50 }, type: "app" },
        { data: { config: { text: "hi" }, keyword: "render/text" }, id: "t1", type: "app" },
      ],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene, { model });
    expect(model.requests[0]?.input).toContain("a RENDER app in the render chain after render before render/text");
    const item = report.items.find((entry) => entry.kind === "app");
    expect(item).toMatchObject({ category: "data", id: "apps/redFill", status: "converted" });
    const inserted = item && item.kind === "app" && item.status === "converted" ? item.insertedRenderImageNodeId : undefined;
    expect(inserted).toBeDefined();
    const renderImage = out.nodes?.find((entry) => entry.id === inserted);
    expect(renderImage).toMatchObject({ data: { config: {}, keyword: "render/image" }, position: { x: 420, y: 50 }, type: "app" });
    expect(out.edges).toEqual([
      { id: "e-1", source: "e1", sourceHandle: "next", target: inserted, targetHandle: "prev", type: "appNodeEdge" },
      { id: "e-2", source: inserted, sourceHandle: "next", target: "t1", targetHandle: "prev", type: "appNodeEdge" },
      expect.objectContaining({ source: "a1", sourceHandle: "fieldOutput", target: inserted, targetHandle: "fieldInput/image", type: "codeNodeEdge" }),
    ]);
    const config = JSON.parse(out.apps!.redFill!.sources!["config.json"]!) as Record<string, unknown>;
    expect(config.category).toBe("data");
    expect(config.output).toEqual([{ name: "image", type: "image" }]);
    expect(out.apps!.redFill!.sources!["app.nim"]).toBeUndefined();
    expect(Object.keys(out.apps!.redFill!.sources!).sort()).toEqual(["app.ts", "config.json"]);
    expect(sceneRequiresCompilation(out)).toBe(false);
    expect(out.settings?.execution).toBe("interpreted");
  });

  it("normalises a render-category config.json to data without another call", async () => {
    const model = fakeModel(() => ({
      files: { "app.ts": "export function get() { return frameos.svg('<svg/>') }", "config.json": JSON.stringify({ category: "render" }) },
      notes: "",
    }));
    const scene: Scene = {
      apps: { p: { sources: { "app.nim": "proc render*(self: App, context: ExecutionContext, image: Image) = discard" } } },
      edges: [{ id: "e-1", source: "e1", sourceHandle: "next", target: "a1", targetHandle: "prev", type: "appNodeEdge" }],
      id: "s1",
      nodes: [renderEvent, { data: { config: {}, keyword: "p" }, id: "a1", type: "app" }],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene, { model });
    expect(report.modelCalls).toBe(1);
    expect(JSON.parse(out.apps!.p!.sources!["config.json"]!)).toMatchObject({ category: "data", output: [{ name: "image", type: "image" }] });
    expect(report.executionAfter).toBe("interpreted");
  });

  it("asks again when a render port exports render() instead of get()", async () => {
    const model = fakeModel((_request, call) =>
      call === 1
        ? { files: { "app.ts": "export function render() { return frameos.svg('<svg/>') }" }, notes: "" }
        : { files: { "app.ts": "export function get() { return frameos.svg('<svg/>') }" }, notes: "" },
    );
    const scene: Scene = {
      apps: { p: { sources: { "app.nim": "proc render*(self: App, context: ExecutionContext, image: Image) = discard" } } },
      edges: [{ id: "e-1", source: "e1", sourceHandle: "next", target: "a1", targetHandle: "prev", type: "appNodeEdge" }],
      id: "s1",
      nodes: [renderEvent, { data: { config: {}, keyword: "p" }, id: "a1", type: "app" }],
      settings: { execution: "compiled" },
    };
    const { report } = await convertScene(scene, { model });
    expect(report.modelCalls).toBe(2);
    expect(model.requests[1]?.input).toContain("must `export function get(app, context)`");
    expect(report.executionAfter).toBe("interpreted");
  });

  it("leaves an interpreted scene without Nim untouched", async () => {
    const scene: Scene = {
      edges: [],
      id: "s1",
      nodes: [renderEvent, { data: { codeJS: "1", codeArgs: [], codeOutputs: [{ name: "v", type: "float" }] }, id: "c1", type: "code" }],
      settings: { execution: "interpreted", refreshInterval: 60 },
    };
    const { scene: out, report } = await convertScene(scene);
    expect(out).toEqual(scene);
    expect(report.items).toEqual([]);
    expect(report.executionBefore).toBe("interpreted");
    expect(report.executionAfter).toBe("interpreted");
  });

  it("converts a scene app used by two nodes once", async () => {
    const model = fakeModel(() => ({ files: { "app.ts": "export function get(app) { return app.config.city }" }, notes: "" }));
    const scene: Scene = {
      apps: { city: { sources: { "app.nim": "proc get*(self: App, context: ExecutionContext): string = self.appConfig.city", "config.json": JSON.stringify({ category: "data", fields: [{ name: "city", type: "string" }], name: "City", output: [{ name: "city", type: "string" }] }) } } },
      edges: [
        { id: "e-1", source: "a1", sourceHandle: "fieldOutput", target: "t1", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        { id: "e-2", source: "a2", sourceHandle: "fieldOutput", target: "t2", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
      ],
      id: "s1",
      nodes: [
        renderEvent,
        { data: { config: { city: "Brussels" }, keyword: "city" }, id: "a1", type: "app" },
        { data: { config: { city: "Tallinn" }, keyword: "city" }, id: "a2", type: "app" },
        { data: { config: {}, keyword: "render/text" }, id: "t1", type: "app" },
        { data: { config: {}, keyword: "render/text" }, id: "t2", type: "app" },
      ],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene, { model });
    expect(report.modelCalls).toBe(1);
    expect(model.requests[0]?.input).toContain("used by 2 node(s)");
    expect(model.requests[0]?.input).toContain("feeds render/text.text, render/text.text");
    expect(model.requests[0]?.input).toContain('Node a1 config: {"city":"Brussels"}');
    expect(out.apps!.city!.sources!["app.ts"]).toContain("app.config.city");
    expect(JSON.parse(out.apps!.city!.sources!["config.json"]!)).toMatchObject({ category: "data", output: [{ name: "city", type: "string" }] });
    expect(out.settings?.execution).toBe("interpreted");
  });

  it("removes leftover Nim from an app that already has JavaScript", async () => {
    const scene: Scene = {
      apps: { both: { sources: { "app.nim": "proc get*() = discard", "app.ts": "export function get() { return 1 }", "config.json": "{}" } } },
      edges: [],
      id: "s1",
      nodes: [renderEvent, { data: { config: {}, keyword: "both" }, id: "a1", type: "app" }],
      settings: { execution: "compiled" },
    };
    const { scene: out, report } = await convertScene(scene);
    expect(report.modelCalls).toBe(0);
    expect(Object.keys(out.apps!.both!.sources!).sort()).toEqual(["app.ts", "config.json"]);
    expect(report.items).toEqual([{ id: "apps/both", kind: "app", name: "both", status: "already_javascript" }]);
    expect(out.settings?.execution).toBe("interpreted");
  });

  it("throws for input that is not a scene", async () => {
    await expect(convertScene({} as Scene)).rejects.toThrow(/string id/);
  });
});

import { describe, expect, it } from "vitest";
import { exampleScenes } from "./context";
import { formatLintIssues, lintScenes } from "./scene-lint";
import type { JsonObject } from "./scene-utils";

function scene(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    edges: [
      { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
    ],
    fields: [],
    id: "scene-1",
    name: "Lint me",
    nodes: [
      { data: { keyword: "render" }, id: "ev", type: "event" },
      { data: { config: { text: "hi" }, keyword: "render/text" }, id: "text", type: "app" },
    ],
    settings: { execution: "interpreted" },
    ...overrides,
  };
}

function messages(scenes: JsonObject[]) {
  const result = lintScenes(scenes);
  return {
    errors: formatLintIssues(result.errors),
    warnings: formatLintIssues(result.warnings),
  };
}

describe("lintScenes", () => {
  it("accepts a minimal render chain", () => {
    expect(messages([scene()])).toEqual({ errors: [], warnings: [] });
  });

  it("rejects config keys that are not fields of the app", () => {
    const { errors } = messages([
      scene({
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: { text: "hi", fontSizePx: "12" }, keyword: "render/text" }, id: "text", type: "app" },
        ],
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no field "fontSizePx"');
    expect(errors[0]).toContain("fontSize");
  });

  it("rejects select values outside the app's options", () => {
    const { errors } = messages([
      scene({
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: { text: "hi", position: "top-left" }, keyword: "render/text" }, id: "text", type: "app" },
        ],
      }),
    ]);
    expect(errors[0]).toContain('"position" must be one of "left", "center", "right"');
  });

  it("requires an image on render/image", () => {
    const { errors } = messages([
      scene({
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/image" }, id: "text", type: "app" },
        ],
      }),
    ]);
    expect(errors).toEqual([expect.stringContaining('needs an image on "image"')]);
  });

  it("accepts an image wired from a data app and flags images into text fields", () => {
    const wired = scene({
      edges: [
        { id: "e1", source: "ev", sourceHandle: "next", target: "img", targetHandle: "prev", type: "appNodeEdge" },
        { id: "e2", source: "src", sourceHandle: "fieldOutput", target: "img", targetHandle: "fieldInput/image", type: "codeNodeEdge" },
      ],
      nodes: [
        { data: { keyword: "render" }, id: "ev", type: "event" },
        { data: { config: {}, keyword: "render/image" }, id: "img", type: "app" },
        { data: { config: { url: "https://example.com/a.png" }, keyword: "data/downloadImage" }, id: "src", type: "app" },
      ],
    });
    expect(messages([wired]).errors).toEqual([]);

    const wrong = scene({
      edges: [
        { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
        { id: "e2", source: "src", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
      ],
      nodes: [
        { data: { keyword: "render" }, id: "ev", type: "event" },
        { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
        { data: { config: { url: "https://example.com/a.png" }, keyword: "data/downloadImage" }, id: "src", type: "app" },
      ],
    });
    expect(messages([wrong]).errors).toEqual([expect.stringContaining("an image output cannot feed a text field")]);
  });

  it("rejects the fieldOutput/<name> handle spelling the runtime ignores", () => {
    const { errors } = messages([
      scene({
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "code", sourceHandle: "fieldOutput/value", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
          { data: { codeJS: "'x'", codeOutputs: [{ name: "value", type: "string" }] }, id: "code", type: "code" },
        ],
      }),
    ]);
    expect(errors).toEqual([expect.stringContaining('sourceHandle "fieldOutput" exactly')]);
  });

  it("requires codeArgs for every codeField edge and fields for every state node", () => {
    const { errors } = messages([
      scene({
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "st", sourceHandle: "fieldOutput", target: "code", targetHandle: "codeField/city", type: "codeNodeEdge" },
          { id: "e3", source: "code", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
          { data: { keyword: "city" }, id: "st", type: "state" },
          { data: { codeJS: "city.toUpperCase()", codeArgs: [], codeOutputs: [{ name: "value", type: "string" }] }, id: "code", type: "code" },
        ],
      }),
    ]);
    expect(errors).toEqual([
      expect.stringContaining('field "city" which is not declared'),
      expect.stringContaining('no codeArgs entry named "city"'),
    ]);
  });

  it("checks render/split cells against the grid and node slots against the catalog", () => {
    const { errors } = messages([
      scene({
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "split", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "split", sourceHandle: "field/render_functions[3][1]", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e3", source: "split", sourceHandle: "field/cells[1][1]", target: "text2", targetHandle: "prev", type: "appNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: { rows: "2", columns: "1" }, keyword: "render/split" }, id: "split", type: "app" },
          { data: { config: { text: "a" }, keyword: "render/text" }, id: "text", type: "app" },
          { data: { config: { text: "b" }, keyword: "render/text" }, id: "text2", type: "app" },
        ],
      }),
    ]);
    expect(errors).toEqual([
      expect.stringContaining("cell [3][1] is outside its 2x1 grid"),
      expect.stringContaining('no node-typed field "cells"'),
    ]);
  });

  it("warns about render apps left off the chain and unused data apps", () => {
    const { errors, warnings } = messages([
      scene({
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: { text: "hi" }, keyword: "render/text" }, id: "text", type: "app" },
          { data: { config: { text: "orphan" }, keyword: "render/text" }, id: "orphan", type: "app" },
          { data: { config: { url: "https://example.com" }, keyword: "data/downloadUrl" }, id: "dl", type: "app" },
        ],
      }),
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining("render app render/text (orphan) is not connected"),
      expect.stringContaining("Data app data/downloadUrl (dl) has no outgoing"),
    ]);
  });

  it("accepts scene-local JS apps declared in the scene's apps map", () => {
    const { errors } = messages([
      scene({
        apps: {
          myApp: {
            category: "data",
            fields: [{ name: "city", type: "string", value: "" }],
            name: "My app",
            output: [{ name: "out", type: "string" }],
            sources: { "app.ts": "export function get() { return 'x' }", "config.json": "{}" },
          },
        },
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "my", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
          { data: { config: { city: "Brussels" }, keyword: "myApp" }, id: "my", type: "app" },
        ],
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it("catches the JS environment mix-ups the runtime only reports at render time", () => {
    const fetching = scene({
      edges: [
        { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
        { id: "e2", source: "code", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
      ],
      nodes: [
        { data: { keyword: "render" }, id: "ev", type: "event" },
        { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
        {
          data: {
            codeJS: "frameos.fetchJson('https://x').title + format(now(), 'HH:mm')",
            codeOutputs: [{ name: "value", type: "string" }],
          },
          id: "code",
          type: "code",
        },
      ],
    });
    const { errors } = messages([fetching]);
    expect(errors).toEqual([
      expect.stringContaining("no `frameos` object"),
      expect.stringContaining('"HH:mm" uses strftime/moment letters'),
    ]);

    const fine = scene({
      edges: [
        { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
        { id: "e2", source: "code", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
      ],
      nodes: [
        { data: { keyword: "render" }, id: "ev", type: "event" },
        { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
        {
          data: { codeJS: "format(now(), '{hour/2}:{minute/2}')", codeOutputs: [{ name: "value", type: "string" }] },
          id: "code",
          type: "code",
        },
      ],
    });
    expect(messages([fine]).errors).toEqual([]);

    const app = scene({
      apps: {
        clockApp: {
          category: "data",
          fields: [],
          name: "Clock app",
          output: [{ name: "out", type: "string" }],
          sources: { "app.ts": "export function get() { return format(now(), '{hour}') }", "config.json": "{}" },
        },
      },
      edges: [
        { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
        { id: "e2", source: "my", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
      ],
      nodes: [
        { data: { keyword: "render" }, id: "ev", type: "event" },
        { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
        { data: { config: {}, keyword: "clockApp" }, id: "my", type: "app" },
      ],
    });
    expect(messages([app]).errors).toEqual([expect.stringContaining("JS apps have no format()/now()/parseTs()")]);
  });

  it("rejects code nodes that claim to output an image", () => {
    const { errors } = messages([
      scene({
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "img", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "code", sourceHandle: "fieldOutput", target: "img", targetHandle: "fieldInput/image", type: "codeNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/image" }, id: "img", type: "app" },
          { data: { codeJS: "'<svg viewBox=\"0 0 1 1\"/>'", codeOutputs: [{ name: "svg", type: "image" }] }, id: "code", type: "code" },
        ],
      }),
    ]);
    expect(errors).toEqual([expect.stringContaining("Code nodes cannot output images")]);
  });

  it("steers scene-local JS apps to the data-app pattern the runtime actually draws", () => {
    const withApp = (category: string, source: string) =>
      scene({
        apps: {
          panel: {
            category,
            fields: [],
            name: "Panel",
            output: [{ name: "image", type: "image" }],
            sources: { "app.ts": source, "config.json": "{}" },
          },
        },
        edges: [{ id: "e1", source: "ev", sourceHandle: "next", target: "panel", targetHandle: "prev", type: "appNodeEdge" }],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "panel" }, id: "panel", type: "app" },
        ],
      });
    expect(messages([withApp("render", "export function run(app) { return frameos.svg('<svg viewBox=\"0 0 1 1\"/>') }")]).errors).toEqual([
      expect.stringContaining('category "render" draw nothing'),
    ]);
    expect(messages([withApp("data", "export function run(app) { return 1 }")]).errors).toEqual([
      expect.stringContaining("must `export function get(app, context)`"),
    ]);
  });

  it("rejects SVG the frame renderer cannot draw and accepts the one gradient form it can", () => {
    const withSvg = (svg: string) =>
      scene({
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: { svg }, keyword: "render/svg" }, id: "text", type: "app" },
        ],
      });
    const good =
      '<svg viewBox="0 0 800 600"><linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="600"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e3a5f"/></linearGradient><rect width="800" height="600" fill="url(#bg)"/></svg>';
    expect(messages([withSvg(good)]).errors).toEqual([]);
    expect(messages([withSvg('<svg viewBox="0 0 8 6"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="6"><stop offset="0" stop-color="#000"/></linearGradient></defs></svg>')]).errors).toEqual([]);
    expect(messages([withSvg('<svg viewBox="0 0 8 6"><defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs></svg>')]).errors).toEqual([
      expect.stringContaining("SVG uses <clipPath>"),
    ]);
    expect(messages([withSvg('<svg viewBox="0 0 8 6"><linearGradient id="g" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#000"/></linearGradient></svg>')]).errors).toEqual([
      expect.stringContaining('linearGradient needs gradientUnits="userSpaceOnUse"'),
    ]);
    expect(messages([withSvg('<svg viewBox="0 0 8 6"><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="4" cy="3" r="4" gradientTransform="scale(1 0.5)"><stop offset="0" stop-color="#000" stop-opacity="0.5"/></radialGradient><rect width="8" height="6" fill="url(#g)"/></svg>')]).errors).toEqual([]);
    expect(messages([withSvg('<svg viewBox="0 0 8 6"><radialGradient id="g" cx="4" cy="3" r="4"><stop offset="0" stop-color="#000"/></radialGradient></svg>')]).errors).toEqual([
      expect.stringContaining('radialGradient needs gradientUnits="userSpaceOnUse"'),
    ]);
    expect(messages([withSvg('<svg viewBox="0 0 8 6"><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="8" y2="0"><stop offset="0" stop-color="#000"/></linearGradient><path d="M 0 0 L 8 6" stroke="url(#g)"/></svg>')]).errors).toEqual([
      expect.stringContaining("stroke cannot reference a gradient"),
    ]);
    expect(messages([withSvg("<svg><rect width='1' height='1'/></svg>")]).errors).toEqual([expect.stringContaining("viewBox")]);
  });

  it("warns about minified sources on scene-local apps", () => {
    const packed = "export function get(app) { " + "var a = 1; ".repeat(60) + "return String(a) }";
    const { errors, warnings } = messages([
      scene({
        apps: {
          panel: {
            category: "data",
            fields: [{ name: "width", type: "integer", value: "800" }, { name: "title", type: "string", value: "" }],
            name: "Panel",
            output: [{ name: "text", type: "string" }],
            sources: { "app.ts": packed + "\n" + packed + "\n" + packed, "config.json": "{}" },
          },
        },
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "p", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
          { data: { config: {}, keyword: "panel" }, id: "p", type: "app" },
        ],
      }),
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("packed onto very long lines")]);
  });

  it("warns when generated SVG pins the canvas to one size", () => {
    const { warnings } = messages([
      scene({
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "code", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        ],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
          { data: { codeJS: "'<svg viewBox=\"0 0 800 600\"></svg>'", codeOutputs: [{ name: "svg", type: "string" }] }, id: "code", type: "code" },
        ],
      }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("hard-coded viewBox (800x600)")]);
  });

  it("rejects code nodes that redeclare one of their arguments", () => {
    const { errors } = messages([
      scene({
        edges: [
          { id: "e1", source: "ev", sourceHandle: "next", target: "text", targetHandle: "prev", type: "appNodeEdge" },
          { id: "e2", source: "st", sourceHandle: "fieldOutput", target: "code", targetHandle: "codeField/lat", type: "codeNodeEdge" },
          { id: "e3", source: "code", sourceHandle: "fieldOutput", target: "text", targetHandle: "fieldInput/text", type: "codeNodeEdge" },
        ],
        fields: [{ name: "lat", type: "string", value: "50.8" }],
        nodes: [
          { data: { keyword: "render" }, id: "ev", type: "event" },
          { data: { config: {}, keyword: "render/text" }, id: "text", type: "app" },
          { data: { keyword: "lat" }, id: "st", type: "state" },
          {
            data: { codeArgs: [{ name: "lat", type: "string" }], codeJS: "(() => { const lat = Number(lat) || 0; return String(lat); })()", codeOutputs: [{ name: "value", type: "string" }] },
            id: "code",
            type: "code",
          },
        ],
      }),
    ]);
    expect(errors).toEqual([expect.stringContaining('redeclares its argument "lat"')]);
  });

  // Every shipped example must lint clean — the linter is only useful if it
  // does not reject the scenes the catalog itself ships. Three legacy values
  // in old samples are known (and real: the runtime falls back on them);
  // anything beyond that list is a regression in the linter.
  it("lints every bundled example scene without unexpected errors", () => {
    const knownLegacy = new Set([
      "samples/Github stars",
      "samples/MiniGPT",
      "samples/Ken Burns slideshow",
    ]);
    const unexpected: string[] = [];
    let totalWarnings = 0;
    for (const example of exampleScenes()) {
      const result = lintScenes(example.scenes);
      totalWarnings += result.warnings.length;
      if (result.errors.length > 0 && !knownLegacy.has(example.slug)) {
        unexpected.push(`${example.slug}: ${formatLintIssues(result.errors).join(" | ")}`);
      }
      if (knownLegacy.has(example.slug)) {
        expect(result.errors).toHaveLength(1);
      }
    }
    expect(unexpected).toEqual([]);
    expect(totalWarnings).toBeLessThanOrEqual(2);
  });
});

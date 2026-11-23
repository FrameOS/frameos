// What a scene needs of a frame (frontend/src/utils/sceneNeeds.ts): the
// store's badges and screen filter, and what a frame's own store leaves out
// (docs/scene-store.md "What a scene needs").
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sceneFitsFrame, sceneNeeds } from "../../../../../../frontend/src/utils/sceneNeeds";
import {
  storeKindCountsOf,
  storeShelfCountsOf,
  storeShelvesOf,
} from "../../../../../../frontend/src/scenes/store/storeShelves";
import type { TemplateType } from "../../../../../../frontend/src/types";

const samples = join(__dirname, "../../../../../../repo/scenes/samples");
const needsOf = (name: string) => sceneNeeds(JSON.parse(readFileSync(join(samples, name, "scenes.json"), "utf8")));

describe("scene needs", () => {
  it("reads a fast screen from a refresh under a second, never for a layout", () => {
    expect(sceneNeeds([{ settings: { refreshInterval: 0.03 } }])).toEqual(["fast"]);
    expect(sceneNeeds([{ settings: { refreshInterval: 1 } }])).toEqual([]);
    expect(sceneNeeds([{ settings: { refreshInterval: 0.03, isLayout: true } }])).toEqual([]);
  });

  it("reads touch & mouse, a keyboard and the frame's buttons from handlers and events, and Linux from the apps that spawn", () => {
    const tap = { apps: { a: { sources: { "app.tsx": "<div onClick={() => go()} />" } } } };
    expect(sceneNeeds([tap])).toEqual(["touch"]);
    const keys = { nodes: [{ type: "event", data: { keyword: "keyDown" } }] };
    expect(sceneNeeds([keys])).toEqual(["keys"]);
    const buttons = { nodes: [{ type: "event", data: { keyword: "button" } }] };
    expect(sceneNeeds([buttons])).toEqual(["buttons"]);
    // A button the screen draws is no key.
    expect(sceneNeeds([{ apps: { a: { sources: { "app.tsx": '<div look="button" />' } } } }])).toEqual([]);
    const chromium = { nodes: [{ type: "app", data: { keyword: "data/chromiumScreenshot" } }] };
    expect(sceneNeeds([chromium])).toEqual(["linux"]);
    expect(needsOf("Counter")).toEqual(["buttons", "round"]);
    expect(sceneNeeds([{}], ["shell"])).toEqual(["linux"]);
  });

  it("files the samples as their descriptions say", () => {
    expect(needsOf("Star shooter")).toContain("fast");
    // Snake turns into a slow puzzle on e-paper, and says so (settings.needs).
    expect(needsOf("Snake")).toEqual(["touch", "keys", "buttons", "round"]);
    expect(needsOf("Sudoku")).not.toContain("fast");
    expect(needsOf("Sudoku")).toContain("touch");
    expect(needsOf("Weather")).toEqual([]);
    expect(needsOf("Webcam RSTP")).toEqual(["linux"]);
    expect(needsOf("Windows 98 layout")).not.toContain("fast");
    // Round: the clocks lay out in the circle, a photo fills it, a layout says nothing.
    expect(needsOf("Analog clock face")).toContain("round");
    expect(needsOf("Immich")).toContain("round");
    expect(needsOf("Webcam RSTP")).not.toContain("round");
    expect(needsOf("Windows 98 layout")).not.toContain("round");
    for (const name of readdirSync(samples)) {
      if (existsSync(join(samples, name, "scenes.json"))) {
        expect(Array.isArray(needsOf(name))).toBe(true);
      }
    }
  });

  it("takes what a scene states over what it reads, and Linux from the risk flags whatever it says", () => {
    const stated = { settings: { needs: ["touch", "nonsense"], refreshInterval: 0.03 } };
    expect(sceneNeeds([stated])).toEqual(["touch"]);
    expect(sceneNeeds([stated], ["shell"])).toEqual(["touch", "linux"]);
  });

  it("reads a round screen from code that asks whether it is one, or from settings.round either way", () => {
    const asks = (code: string) => ({ apps: { a: { sources: { "app.tsx": code } } } });
    expect(sceneNeeds([asks("const round = context.round === true")])).toEqual(["round"]);
    expect(sceneNeeds([asks("if (app.frame.round) layoutInCircle()")])).toEqual(["round"]);
    expect(sceneNeeds([asks("const round = context?.round === true")])).toEqual(["round"]);
    // Math.round is no round screen, nor is a layout's own code.
    expect(sceneNeeds([asks("const x = Math.round(w / 2)")])).toEqual([]);
    expect(sceneNeeds([{ ...asks("context.round"), settings: { isLayout: true } }])).toEqual([]);
    // Said by the scene: a photo that fills the screen has no code to ask.
    expect(sceneNeeds([{ settings: { round: true } }])).toEqual(["round"]);
    expect(sceneNeeds([{ ...asks("context.round"), settings: { round: false } }])).toEqual([]);
    // Stated needs keep it: round is no need of its own.
    expect(sceneNeeds([{ ...asks("context.round"), settings: { needs: ["touch", "round"] } }])).toEqual([
      "touch",
      "round",
    ]);
    expect(sceneNeeds([{ settings: { needs: ["round"] } }])).toEqual([]);
    // And it rules nothing out.
    expect(sceneFitsFrame(["round"], { fast: false, linux: false })).toBe(true);
  });

  it("rules out only what a frame cannot run", () => {
    expect(sceneFitsFrame(["fast", "touch"], { fast: false })).toBe(false);
    expect(sceneFitsFrame(["touch", "keys"], { fast: false, linux: false })).toBe(true);
    expect(sceneFitsFrame(["linux"], { linux: false })).toBe(false);
    expect(sceneFitsFrame(undefined, { fast: false })).toBe(true);
  });
});

describe("the store front's split and screen filter", () => {
  const templates: TemplateType[] = [
    { name: "Snake", category: "games", needs: ["fast", "keys"] },
    { name: "Sudoku", category: "games", needs: ["touch", "keys"] },
    { name: "Weather", category: "weather" },
    { name: "Top bar", category: "layouts" },
    { name: "Windows 98", category: "desktops", needs: ["touch"] },
  ];
  const shelf = (groups: ReturnType<typeof storeShelvesOf>) =>
    groups.map((group) => [group.shelf.slug, group.templates.map((template) => template.name)]);

  it("shows scenes or layouts, never both", () => {
    expect(storeKindCountsOf(templates)).toEqual({ layout: 2, scene: 3 });
    expect(shelf(storeShelvesOf(templates, { category: null, kind: "scene", search: "", sort: "name" }))).toEqual([
      ["weather", ["Weather"]],
      ["games", ["Snake", "Sudoku"]],
    ]);
    expect(shelf(storeShelvesOf(templates, { category: null, kind: "layout", search: "", sort: "name" }))).toEqual([
      ["desktops", ["Windows 98"]],
      ["layouts", ["Top bar"]],
    ]);
    expect(storeShelfCountsOf(templates, "layout").map((count) => count.shelf.slug)).toEqual(["desktops", "layouts"]);
  });

  it("filters by screen and input from what each scene needs", () => {
    const names = (fit: "epaper" | "fast" | "touch" | "keys") =>
      storeShelvesOf(templates, { category: null, fit, kind: "scene", search: "", sort: "name" }).flatMap((group) =>
        group.templates.map((template) => template.name),
      );
    expect(names("epaper")).toEqual(["Weather", "Sudoku"]);
    expect(names("fast")).toEqual(["Snake"]);
    expect(names("touch")).toEqual(["Sudoku"]);
    expect(names("keys")).toEqual(["Snake", "Sudoku"]);
  });
});

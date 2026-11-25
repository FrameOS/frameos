// The samples flash.frameos.net offers a standalone ESP32
// (cloud-frontend/src/flasher/sampleCatalog.ts, built into
// flasher-scenes/index.json by cloud-frontend/build.mjs): every repo sample
// such a frame can run, read from the scenes themselves.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareFlasherCategories,
  flasherSampleFile,
  flasherSampleIndex,
  flasherSampleLeftOut,
  type FlasherSampleSource,
} from "../../../../../../cloud-frontend/src/flasher/sampleCatalog";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

function source(name: string, scenes: Record<string, unknown>[]): FlasherSampleSource {
  return { name, description: `${name}.`, scenes };
}

function app(code: string, permissions?: string[], settings?: string[]): Record<string, unknown> {
  const config = { name: "app", ...(permissions ? { permissions } : {}), ...(settings ? { settings } : {}) };
  return { sources: { "config.json": JSON.stringify(config), "app.ts": code } };
}

function sceneWithApp(id: string, code: string, permissions?: string[], settings?: string[]): Record<string, unknown> {
  return {
    id,
    settings: { category: "Notes & tools" },
    nodes: [{ id: "n", type: "app", data: { keyword: "custom" } }],
    apps: { custom: app(code, permissions, settings) },
  };
}

function repoSamples(): FlasherSampleSource[] {
  const sources: FlasherSampleSource[] = [];
  for (const shelf of ["samples", "gallery"]) {
    const dir = join(repoRoot, "repo", "scenes", shelf);
    for (const entry of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const meta = JSON.parse(readFileSync(join(dir, entry.name, "template.json"), "utf8"));
      const scenes = JSON.parse(readFileSync(join(dir, entry.name, String(meta.scenes ?? "./scenes.json")), "utf8"));
      sources.push({ name: entry.name, description: String(meta.description ?? ""), scenes });
    }
  }
  return sources;
}

describe("what a standalone frame cannot run", () => {
  it("leaves out a layout, which shows nothing of its own", () => {
    expect(flasherSampleLeftOut(source("Top bar", [{ id: "bar", settings: { isLayout: true } }]))).toBe("layout");
    expect(flasherSampleLeftOut(source("Nothing", []))).toBe("empty");
  });

  it("leaves out what needs a Raspberry Pi", () => {
    const chromium = { id: "c", nodes: [{ id: "n", type: "app", data: { keyword: "data/chromiumScreenshot" } }] };
    expect(flasherSampleLeftOut(source("Chromium", [chromium]))).toBe("pi");
    const player = sceneWithApp("v", "export function get() { return frameos.video('v', { src: 'x' }) }");
    expect(flasherSampleLeftOut(source("Video player", [player]))).toBe("video");
    // Files plays a video only when one is opened: on an ESP32 it says it cannot.
    expect(flasherSampleLeftOut(source("Files", [player]))).toBeNull();
  });

  it("leaves out what reads an account's key, which a frame with no plane is never given", () => {
    const keyed = sceneWithApp("k", "export function get() { return getSetting('openAI', 'apiKey') }", [], ["openAI"]);
    expect(flasherSampleLeftOut(source("Haiku", [keyed]))).toBe("key");
    const plain = sceneWithApp("p", "export function get() { return 1 }");
    expect(flasherSampleLeftOut(source("Plain", [plain]))).toBeNull();
  });
});

describe("the flasher's index", () => {
  it("puts the store first, then the categories in the store's order, then names", () => {
    const index = flasherSampleIndex([
      source("Weather", [{ id: "weather", settings: { category: "Weather" } }]),
      source("Zen clock", [{ id: "zen", settings: { category: "Clocks & time" } }]),
      source("Abacus", [{ id: "abacus" }]),
      source("Clock", [{ id: "clock", settings: { category: "Clocks & time" } }]),
      source("Scene store", [{ id: "scene-store", settings: { category: "Notes & tools" } }]),
      source("Terminal", [{ id: "terminal", settings: { category: "System" } }]),
    ]);
    expect(index.samples.map((sample) => sample.name)).toEqual([
      "Scene store",
      "Terminal",
      "Clock",
      "Zen clock",
      "Weather",
      "Abacus",
    ]);
    expect(index.samples[0]).toMatchObject({ store: true, file: "scene-store.json", scenes: 1 });
    expect(index.samples.find((sample) => sample.name === "Abacus")?.category).toBe("Other");
    expect(compareFlasherCategories("System", "Photos")).toBeLessThan(0);
    expect(compareFlasherCategories("Other", "Zebras")).toBeGreaterThan(0);
  });

  it("refuses two samples with one scene id, and a list with no store", () => {
    expect(() =>
      flasherSampleIndex([
        source("Scene store", [{ id: "scene-store" }]),
        source("A", [{ id: "same" }]),
        source("B", [{ id: "same" }]),
      ]),
    ).toThrow(/share the scene id "same"/);
    expect(() => flasherSampleIndex([source("A", [{ id: "a" }])])).toThrow(/no Scene store/);
  });

  it("names each sample's file after it", () => {
    expect(flasherSampleFile("Weather, painted")).toBe("weather-painted.json");
    expect(flasherSampleFile("2048")).toBe("2048.json");
    expect(flasherSampleFile("Café ☕")).toBe("cafe.json");
  });

  it("offers the repo's samples that run on an ESP32 of its own", () => {
    const index = flasherSampleIndex(repoSamples());
    const names = index.samples.map((sample) => sample.name);
    expect(names[0]).toBe("Scene store");
    for (const tool of ["Files", "Terminal app", "Code editor", "Calculator", "Clock", "Weather"]) {
      expect(names).toContain(tool);
    }
    for (const sample of index.samples) {
      expect(sample.needs).not.toContain("linux");
      expect(sample.bytes).toBeLessThan(512 * 1024);
    }
    const leftOut = new Map(index.leftOut.map((entry) => [entry.name, entry.why]));
    expect(leftOut.get("Windows 98 layout")).toBe("layout");
    expect(leftOut.get("Video player")).toBe("video");
    expect(leftOut.get("Chromium Screenshot")).toBe("pi");
    expect(leftOut.get("OpenAI image")).toBe("key");
    // A set holds 128 scenes: "Everything" has to fit in it.
    expect(index.samples.reduce((sum, sample) => sum + sample.scenes, 0)).toBeLessThanOrEqual(128);
  });
});

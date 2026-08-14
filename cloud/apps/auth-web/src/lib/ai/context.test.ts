import { describe, expect, it } from "vitest";
import {
  appCatalog,
  docs,
  exampleScenes,
  getApp,
  getExample,
  jsTypeDeclarations,
  knownAppKeywords,
  readDoc,
  searchApps,
  searchDocs,
  searchExamples,
} from "./context";
import { buildSystemPrompt } from "./prompts";

describe("bundled AI context", () => {
  it("carries the full app catalog", () => {
    const catalog = appCatalog();
    expect(Object.keys(catalog).length).toBeGreaterThan(40);
    const renderText = getApp("render/text");
    expect(renderText?.category).toBe("render");
    expect(Array.isArray(renderText?.fields)).toBe(true);
    expect(knownAppKeywords().has("data/clock") || knownAppKeywords().has("render/image")).toBe(
      true,
    );
  });

  it("bundles JS app sources but never Nim", () => {
    const catalog = appCatalog();
    const repoApps = Object.values(catalog).filter((app) =>
      app.keyword.startsWith("repo/apps/code/"),
    );
    expect(repoApps.length).toBeGreaterThan(3);
    const withSources = repoApps.filter(
      (app) => app.sources && Object.keys(app.sources).length > 0,
    );
    expect(withSources.length).toBeGreaterThan(0);
    for (const app of Object.values(catalog)) {
      for (const file of Object.keys(app.sources ?? {})) {
        expect(file.endsWith(".nim")).toBe(false);
      }
    }
  });

  it("finds apps by keyword search", () => {
    const hits = searchApps("text render");
    expect(hits.map((app) => app.keyword)).toContain("render/text");
    const dataOnly = searchApps(undefined, "data");
    expect(dataOnly.every((app) => app.category === "data")).toBe(true);
  });

  it("serves example scenes with full JSON", () => {
    expect(exampleScenes().length).toBeGreaterThan(20);
    const weatherHits = searchExamples("weather");
    expect(weatherHits.length).toBeGreaterThan(0);
    const weather = getExample("samples/Weather");
    expect(weather).toBeDefined();
    expect(Array.isArray(weather?.scenes)).toBe(true);
    // Every bundled example is an interpreted scene.
    for (const example of exampleScenes()) {
      for (const scene of example.scenes) {
        expect((scene as { settings?: { execution?: string } }).settings?.execution).toBe(
          "interpreted",
        );
      }
    }
  });

  it("searches and reads docs", () => {
    expect(docs().length).toBeGreaterThan(5);
    const hits = searchDocs("frame commands verbs");
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0]!;
    const content = readDoc(first.path);
    expect(content).toBeTruthy();
  });

  it("has the QuickJS type declarations", () => {
    expect(jsTypeDeclarations()).toContain("FrameOSContext");
    expect(jsTypeDeclarations()).toContain("declare const frameos");
  });
});

describe("buildSystemPrompt", () => {
  it("is stable, Nim-free, and mentions the delivery tools", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toBe(buildSystemPrompt());
    expect(prompt).not.toMatch(/\bnim\b/i);
    expect(prompt).not.toMatch(/app\.nim/i);
    expect(prompt).toContain("create_scenes");
    expect(prompt).toContain("update_scene");
    expect(prompt).toContain('"interpreted"');
    expect(prompt).toContain("FrameOSContext");
  });
});

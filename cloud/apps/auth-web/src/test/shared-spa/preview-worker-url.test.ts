// @vitest-environment jsdom
//
// The scene workspace's live preview and AI render check start the
// frameos-wasm worker. They asked for it at a bare "/frameos-wasm/...", while
// every other preview in the SPA went through assetUrl. On a backend behind
// Home Assistant ingress the SPA lives under /api/hassio_ingress/<token>/, so
// the bare path asked Home Assistant itself for the worker, got no script,
// and a frame's scene page showed "Loading FrameOS runtime…" then "FrameOS
// preview worker failed to load" (2026-11-18). The cloud's frames SPA has the
// same shape under /frames-app.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewWorkerUrl } from "../../../../../../frontend/src/sceneWorkspace/lib/preview-worker";
import { renderSceneCheck } from "../../../../../../frontend/src/sceneWorkspace/lib/scene-render-check";

type ConfigWindow = Window & {
  FRAMEOS_APP_CONFIG?: { ingress_path?: string; assets_base_path?: string };
};
const testWindow = window as ConfigWindow;

const ingressPath = "/api/hassio_ingress/abc123token/";

afterEach(() => {
  delete testWindow.FRAMEOS_APP_CONFIG;
  vi.unstubAllGlobals();
});

describe("previewWorkerUrl", () => {
  it("is root-absolute on a page with no prefix (the store, a plain backend)", () => {
    expect(previewWorkerUrl()).toBe("/frameos-wasm/preview-worker.js");
    testWindow.FRAMEOS_APP_CONFIG = { ingress_path: "" };
    expect(previewWorkerUrl()).toBe("/frameos-wasm/preview-worker.js");
  });

  it("is under the ingress path on a backend behind Home Assistant", () => {
    testWindow.FRAMEOS_APP_CONFIG = { ingress_path: ingressPath };
    expect(previewWorkerUrl()).toBe("/api/hassio_ingress/abc123token/frameos-wasm/preview-worker.js");
  });

  it("is under the assets base path in the cloud's frames SPA", () => {
    testWindow.FRAMEOS_APP_CONFIG = { ingress_path: "", assets_base_path: "/frames-app" };
    expect(previewWorkerUrl()).toBe("/frames-app/frameos-wasm/preview-worker.js");
  });
});

describe("renderSceneCheck", () => {
  it("starts its worker under the ingress path", async () => {
    testWindow.FRAMEOS_APP_CONFIG = { ingress_path: ingressPath };
    const urls: string[] = [];
    class FakeWorker {
      onerror: ((event: { message: string }) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        urls.push(String(url));
      }
      postMessage() {
        // The script was not found: what a worker under a wrong URL does.
        queueMicrotask(() => this.onerror?.({ message: "" }));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);

    const result = await renderSceneCheck({
      scenes: [{ id: "scene-1", nodes: [], edges: [] }],
      sceneId: "scene-1",
      width: 100,
      height: 100,
      settings: {},
    });

    expect(urls).toEqual(["/api/hassio_ingress/abc123token/frameos-wasm/preview-worker.js"]);
    expect(result.rendered).toBe(false);
  });
});

// Every worker the SPA starts is an asset under the page's base path: no
// `new Worker("/...")` and no `workerUrl: "/..."` written as a literal.
describe("worker URLs in the shared SPA", () => {
  const repoRoot = resolve(__dirname, "../../../../../..");
  const frontendSrc = resolve(repoRoot, "frontend/src");
  const rootAbsoluteWorker = /(new\s+Worker\s*\(|workerUrl\s*:)\s*["'`]\//;

  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        files.push(...sourceFiles(path));
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(path);
      }
    }
    return files;
  }

  it("never names a worker by a root-absolute literal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(frontendSrc)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (rootAbsoluteWorker.test(line)) {
            offenders.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

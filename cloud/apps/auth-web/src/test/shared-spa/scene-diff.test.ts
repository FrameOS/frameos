// What a scene update changes, as the deploy drawer shows it
// (frontend/src/utils/sceneDiff.ts, lineDiff.ts): the scene's code as files,
// an app's TSX diffed line by line rather than as a string inside scene JSON.

import { describe, expect, it } from "vitest";
import type { FrameScene } from "../../../../../../frontend/src/types";
import { diffHunks, diffLines, splitLines } from "../../../../../../frontend/src/utils/lineDiff";
import { diffSceneFiles, sceneCodeFiles } from "../../../../../../frontend/src/utils/sceneDiff";

const appV1 = 'export function get() {\n  return <div>Hello</div>\n}\n';
const appV2 = 'export function get() {\n  const name = "world"\n  return <div>Hello {name}</div>\n}\n';

function clockScene(id: string, app: string, extra: Partial<FrameScene> = {}): FrameScene {
  return {
    id,
    name: "Clock",
    nodes: [
      { id: "render", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } },
      { id: "app-1", type: "app", position: { x: 200, y: 0 }, data: { keyword: "clock", config: {} } },
      { id: "code-1", type: "code", position: { x: 0, y: 200 }, data: { codeJS: "return 1 + 1" } },
    ],
    edges: [],
    apps: { clock: { name: "Clock", sources: { "app.tsx": app, "config.json": '{\n  "name": "Clock"\n}\n' } } },
    ...extra,
  } as unknown as FrameScene;
}

describe("the line diff", () => {
  it("finds the shortest edit and numbers both sides", () => {
    const lines = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(lines.map((line) => `${line.kind[0]}${line.text}`)).toEqual(["ca", "rb", "ax", "cc", "cd", "ae"]);
    expect(lines[2]).toEqual({ kind: "add", text: "x", newLine: 2 });
    expect(lines[1]).toEqual({ kind: "remove", text: "b", oldLine: 2 });
  });

  it("keeps three lines of context around each change and splits far-apart ones", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[2] = "changed 2";
    after[25] = "changed 25";
    const hunks = diffHunks(diffLines(before, after));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[1]!.oldStart).toBe(23);
    expect(hunks[1]!.lines.filter((line) => line.kind === "context")).toHaveLength(6);
    expect(diffHunks(diffLines(before, before))).toEqual([]);
  });

  it("drops the empty line a trailing newline leaves", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("a scene as files", () => {
  it("takes the code out of scene.json: app sources, code nodes", () => {
    const files = sceneCodeFiles(clockScene("s1", appV1));
    expect(files.map((file) => file.path)).toEqual([
      "scene.json",
      "apps/clock/app.tsx",
      "apps/clock/config.json",
      "code/code-1.js",
    ]);
    const sceneJson = files[0]!.text;
    expect(sceneJson).not.toContain("<div>");
    expect(sceneJson).toContain('"app.tsx": "<apps/clock/app.tsx>"');
    expect(sceneJson).toContain('"codeJS": "<code/code-1.js>"');
    expect(files[1]!.text).toBe(appV1);
  });

  it("diffs an app's TSX line by line, and scene.json only where the scene moved", () => {
    const diffs = diffSceneFiles([clockScene("s1", appV1)], [clockScene("s1", appV2)]);
    expect(diffs.map((diff) => diff.path)).toEqual(["apps/clock/app.tsx"]);
    const [app] = diffs;
    expect(app!.status).toBe("changed");
    expect(app!.removed).toBe(1);
    expect(app!.added).toBe(2);
    const changed = app!.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context");
    expect(changed.map((line) => line.text)).toEqual([
      "  return <div>Hello</div>",
      '  const name = "world"',
      "  return <div>Hello {name}</div>",
    ]);
  });

  it("puts each scene of a pack in its own folder and names files that come and go", () => {
    const second = { ...clockScene("s2", appV1), name: "Weather", apps: {} } as FrameScene;
    const diffs = diffSceneFiles([clockScene("s1", appV1)], [clockScene("s1", appV1), second]);
    expect(diffs.map((diff) => `${diff.status} ${diff.path}`)).toEqual([
      "added Weather/scene.json",
      "added Weather/code/code-1.js",
    ]);
  });
});


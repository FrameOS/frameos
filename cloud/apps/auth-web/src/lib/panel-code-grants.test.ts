import { describe, expect, it } from "vitest";
import { declaredSceneGrants, grantsWidenedBy } from "./panel-code-grants";

function appScene(apps: Record<string, Record<string, string>>, nodes: unknown[] = []) {
  return {
    apps: Object.fromEntries(Object.entries(apps).map(([keyword, sources]) => [keyword, { sources }])),
    edges: [],
    id: "scene-1",
    name: "Scene",
    nodes,
  };
}

const config = (value: unknown) => JSON.stringify(value);

describe("declaredSceneGrants", () => {
  it("is the union of every app's config.json permissions and settings", () => {
    const scene = appScene({
      clock: { "app.ts": "export function get() {}", "config.json": config({ permissions: ["assets"], settings: ["openAI"] }) },
      editor: {
        "app.tsx": "frameos.code('read')",
        "config.json": config({ permissions: ["code", "frame"], settings: ["homeAssistant", "openAI"] }),
      },
    });
    expect(declaredSceneGrants(scene)).toEqual({
      permissions: ["assets", "code", "frame"],
      settings: ["homeAssistant", "openAI"],
    });
  });

  it("reads an app node's own sources too", () => {
    const scene = {
      id: "s",
      nodes: [
        {
          data: { keyword: "inline", sources: { "app.ts": "", "config.json": config({ permissions: ["files"] }) } },
          id: "n",
          type: "app",
        },
      ],
    };
    expect(declaredSceneGrants(scene).permissions).toEqual(["files"]);
  });

  it("is lenient: a config.json that does not parse, or junk in a list, asks for nothing", () => {
    const scene = appScene({
      broken: { "app.ts": "", "config.json": "{ not json" },
      junk: { "app.ts": "", "config.json": config({ permissions: [1, null, "", "assets"], settings: "openAI" }) },
    });
    expect(declaredSceneGrants(scene)).toEqual({ permissions: ["assets"], settings: [] });
    expect(declaredSceneGrants(null)).toEqual({ permissions: [], settings: [] });
    expect(declaredSceneGrants("scene")).toEqual({ permissions: [], settings: [] });
  });

  it("gives an app with no list the one its code calls for, as every push does", () => {
    const scene = appScene({ sneaky: { "app.ts": "frameos.frame('reboot')", "config.json": config({ name: "x" }) } });
    expect(declaredSceneGrants(scene).permissions).toContain("frame");
  });
});

describe("grantsWidenedBy", () => {
  const plain = { permissions: ["assets"], settings: [] };
  const red = { permissions: ["assets", "code", "frame"], settings: ["openAI"] };

  it("lets a new scene ask for what is not red, and nothing else", () => {
    expect(grantsWidenedBy(null, plain)).toEqual([]);
    expect(grantsWidenedBy(null, red)).toEqual(["code", "frame", "key:openAI"]);
    expect(grantsWidenedBy(null, { permissions: ["assets-write", "files", "shell"], settings: [] })).toEqual([
      "assets-write",
      "files",
      "shell",
    ]);
  });

  it("lets a saved scene keep what it asked for, and ask for no more", () => {
    expect(grantsWidenedBy(red, red)).toEqual([]);
    expect(grantsWidenedBy(red, plain)).toEqual([]);
    expect(grantsWidenedBy(plain, red)).toEqual(["code", "frame", "key:openAI"]);
    expect(grantsWidenedBy({ permissions: [], settings: [] }, plain)).toEqual(["assets"]);
    // `files` reads what `assets` reads.
    expect(grantsWidenedBy({ permissions: ["files"], settings: [] }, plain)).toEqual([]);
  });

  it("reads the frame's scene and the edit the same way", () => {
    const before = appScene({ a: { "app.ts": "", "config.json": config({ permissions: ["code"] }) } });
    const after = appScene({
      a: { "app.ts": "", "config.json": config({ permissions: ["code"] }) },
      b: { "app.ts": "", "config.json": config({ settings: ["unsplash"] }) },
    });
    expect(grantsWidenedBy(declaredSceneGrants(before), declaredSceneGrants(after))).toEqual(["key:unsplash"]);
    expect(grantsWidenedBy(declaredSceneGrants(after), declaredSceneGrants(before))).toEqual([]);
  });
});

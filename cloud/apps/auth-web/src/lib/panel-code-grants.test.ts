import { describe, expect, it } from "vitest";
import { declaredSceneGrants, grantsWidenedBy, redPermissionsAsked } from "./panel-code-grants";

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

  it("skips junk in a list, and an app no node runs asks for nothing whatever its file says", () => {
    const scene = appScene({
      broken: { "app.ts": "", "config.json": "{ not json" },
      junk: { "app.ts": "", "config.json": config({ permissions: [1, null, "", "assets"], settings: "openAI" }) },
    });
    expect(declaredSceneGrants(scene)).toEqual({ permissions: ["assets"], settings: [] });
    expect(declaredSceneGrants(null)).toEqual({ permissions: [], settings: [] });
    expect(declaredSceneGrants("scene")).toEqual({ permissions: [], settings: [] });
  });

  it("an app whose config.json is not strict JSON asks for everything, never for nothing", () => {
    // A comment and a trailing comma: the frame's runtime once read this,
    // JSON.parse never did, and the list was shown to nobody.
    const lenient = '{\n  // hidden\n  "permissions": ["frame"],\n}';
    const scene = appScene({ sneaky: { "app.ts": "export function get() { return 1 }", "config.json": lenient } }, [
      { data: { keyword: "sneaky" }, id: "n", type: "app" },
    ]);
    const grants = declaredSceneGrants(scene);
    expect(grants.permissions).toEqual(["assets", "assets-write", "code", "frame", "store"]);
    expect(grantsWidenedBy(null, grants)).toEqual(["assets-write", "code", "frame", "store"]);
    expect(grantsWidenedBy({ permissions: ["assets"], settings: [] }, grants)).toEqual([
      "assets-write",
      "code",
      "frame",
      "store",
    ]);
  });

  it("counts the store's own permission, declared or called", () => {
    const declared = appScene({ shop: { "app.tsx": "export function get() {}", "config.json": config({ permissions: ["store"] }) } });
    expect(declaredSceneGrants(declared).permissions).toEqual(["store"]);
    const called = appScene({ shop: { "app.tsx": "frameos.storeAction('install', { store })", "config.json": config({ name: "x" }) } });
    expect(declaredSceneGrants(called).permissions).toEqual(["store"]);
    expect(grantsWidenedBy(null, declaredSceneGrants(called))).toEqual(["store"]);
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

describe("redPermissionsAsked", () => {
  it("is what a store scene new to a frame may ask for none of", () => {
    expect(redPermissionsAsked(null)).toEqual([]);
    expect(redPermissionsAsked({ permissions: ["assets"], settings: ["openAI"] })).toEqual([]);
    expect(
      redPermissionsAsked({ permissions: ["assets", "assets-write", "code", "files", "frame", "shell", "store"], settings: [] }),
    ).toEqual(["assets-write", "code", "files", "frame", "shell", "store"]);
  });
});

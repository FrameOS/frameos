// @vitest-environment jsdom
//
// The cloud "save scenes to my account" flow (frontend/src/utils/
// cloudFrameScenesSave.ts) is what turned one account's cloud scene library
// into "Abstract Architecture 2" … "8": every settings save republished
// every owned scene and forked every assigned scene the account did not
// own into a fresh private copy — because the form holds SANITIZED scenes
// and the flow compared them byte-for-byte with the raw store JSON, so
// nothing ever looked unedited. This pins the three guards: unedited scenes
// are left alone (given the workspace's own equality), a pack whose
// scenes.json cannot be re-read keeps its hydrated scenes claimed, and two
// saves for one frame run one after the other.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSceneSource, FrameScene } from "../../../../../../frontend/src/types";
import { persistAndPushCloudFrameScenes } from "../../../../../../frontend/src/utils/cloudFrameScenesSave";
import type { FrameId } from "../../../../../../frontend/src/utils/frameId";

const fetchMock = vi.fn<typeof fetch>();
const frameId = "frame-1" as unknown as FrameId;

// A tiny in-memory store: assignments per frame, scenes.json per store scene.
type Store = {
  assignments: { scene_id: string; scene_version?: number | null; name?: string }[];
  scenes: Map<string, { scenes: FrameScene[]; owned: boolean; version: number }>;
  created: string[];
  updated: string[];
  pushes: unknown[];
  nextId: number;
};

function fakeStore(): Store {
  return { assignments: [], scenes: new Map(), created: [], updated: [], pushes: [], nextId: 1 };
}

function installFetch(store: Store, options: { scenesJsonStatus?: (storeSceneId: string) => number } = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://cloud.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let match: RegExpMatchArray | null;
    if (url.pathname === `/api/frames/${frameId}/scenes` && method === "GET") {
      return Response.json({
        scenes: store.assignments.map((row) => ({
          ...row,
          name: row.name ?? store.scenes.get(row.scene_id)?.scenes[0]?.name ?? null,
        })),
      });
    }
    if (url.pathname === `/api/frames/${frameId}/scenes` && method === "POST") {
      store.pushes.push(body);
      store.assignments = (body.scenes as { scene_id: string; scene_version?: number }[]).map((row) => ({
        scene_id: row.scene_id,
        scene_version: row.scene_version ?? null,
      }));
      return Response.json({ ok: true });
    }
    if ((match = url.pathname.match(/^\/api\/store\/scenes\/([^/]+)\/scenes\.json$/))) {
      const status = options.scenesJsonStatus?.(match[1]!) ?? 200;
      if (status !== 200) {
        return new Response("{}", { status });
      }
      const entry = store.scenes.get(match[1]!);
      return entry ? Response.json(entry.scenes) : new Response("{}", { status: 404 });
    }
    if ((match = url.pathname.match(/^\/api\/account\/scenes\/([^/]+)\/content$/))) {
      const entry = store.scenes.get(match[1]!);
      if (!entry || !entry.owned) {
        return Response.json({ error: "scene_not_found" }, { status: 404 });
      }
      entry.scenes = body.scenes as FrameScene[];
      entry.version += 1;
      store.updated.push(match[1]!);
      return Response.json({ scene: { version: entry.version } });
    }
    if (url.pathname === "/api/account/scenes" && method === "POST") {
      const id = `new-${store.nextId++}`;
      store.scenes.set(id, { scenes: body.scenes as FrameScene[], owned: true, version: 1 });
      store.created.push(String(body.name));
      return Response.json({ scene: { id } });
    }
    throw new Error(`unexpected fetch ${method} ${url.pathname}`);
  });
}

function storedScene(id: string, name: string): FrameScene {
  // Raw scenes.json shape: no positions, no settings defaults — what the
  // store serves and what the workspace sanitizes on hydration.
  return {
    id,
    name,
    nodes: [{ id: `${id}-render`, type: "event", data: { keyword: "render" } }],
    edges: [],
  } as unknown as FrameScene;
}

function sanitizedCopy(scene: FrameScene): FrameScene {
  // What the form holds after sanitizeScene: positions filled, defaults
  // materialized. Byte-different from the stored copy, semantically the same.
  return {
    ...scene,
    nodes: scene.nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
    apps: {},
    fields: [],
    settings: { refreshInterval: 300, backgroundColor: "#000000", execution: "interpreted" },
  } as unknown as FrameScene;
}

// The workspace's real equality is sceneEqualForComparison(sanitize(stored),
// sanitize(form)); here "same id and same node ids" stands in for it — the
// point is that the CALLER decides, not a byte comparison.
const workspaceEquality = (stored: FrameScene, form: FrameScene) =>
  stored.id === form.id &&
  JSON.stringify(stored.nodes.map((n) => n.id)) === JSON.stringify(form.nodes.map((n) => n.id));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  (window as Window & { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = { cloudMode: true, ingress_path: "" };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud scene persistence", () => {
  it("leaves an unedited scene alone — no new version, no fork, assignment kept", async () => {
    const store = fakeStore();
    // A public scene the account does NOT own (a store install)…
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Abstract Architecture")], owned: false, version: 3 });
    // …and one it does.
    store.scenes.set("mine-1", { scenes: [storedScene("rt-2", "Clock")], owned: true, version: 1 });
    store.assignments = [{ scene_id: "public-1" }, { scene_id: "mine-1" }];
    installFetch(store);

    const form = [sanitizedCopy(storedScene("rt-1", "Abstract Architecture")), sanitizedCopy(storedScene("rt-2", "Clock"))];
    const outcome = await persistAndPushCloudFrameScenes(frameId, form, null, { sceneUnchanged: workspaceEquality });

    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);
    expect(outcome.changedStoreSceneIds).toEqual([]);
    expect(store.assignments.map((row) => row.scene_id)).toEqual(["public-1", "mine-1"]);
  });

  it("without the workspace's equality the raw comparison forks — which is exactly the bug", async () => {
    // Documented so the default is understood as a last resort: a sanitized
    // form copy never byte-equals the stored JSON.
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Abstract Architecture")], owned: false, version: 3 });
    store.assignments = [{ scene_id: "public-1" }];
    installFetch(store);

    await persistAndPushCloudFrameScenes(frameId, [sanitizedCopy(storedScene("rt-1", "Abstract Architecture"))]);
    expect(store.created).toEqual(["Abstract Architecture"]);
  });

  it("still publishes a real edit: owned scenes get a version, foreign ones a private fork", async () => {
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Abstract Architecture")], owned: false, version: 3 });
    store.scenes.set("mine-1", { scenes: [storedScene("rt-2", "Clock")], owned: true, version: 1 });
    store.assignments = [{ scene_id: "public-1" }, { scene_id: "mine-1" }];
    installFetch(store);

    const editedForeign = sanitizedCopy(storedScene("rt-1", "Abstract Architecture"));
    editedForeign.nodes = [...editedForeign.nodes, { id: "added", type: "app", data: {} } as never];
    const editedMine = sanitizedCopy(storedScene("rt-2", "Clock"));
    editedMine.nodes = [];
    const outcome = await persistAndPushCloudFrameScenes(frameId, [editedForeign, editedMine], null, {
      sceneUnchanged: workspaceEquality,
    });

    expect(store.updated).toEqual(["mine-1"]);
    expect(store.created).toEqual(["Abstract Architecture"]);
    expect(store.assignments.map((row) => row.scene_id)).toEqual(["new-1", "mine-1"]);
    expect(outcome.notes).toEqual(['Saved the edited "Abstract Architecture" as a new private cloud scene']);
  });

  it("keeps a pack claimed when its scenes.json cannot be re-read (rate limit, blip)", async () => {
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Abstract Architecture")], owned: false, version: 3 });
    store.assignments = [{ scene_id: "public-1", name: "Abstract Architecture" }];
    installFetch(store, { scenesJsonStatus: () => 429 });

    // What hydration recorded before the store went quiet: rt-1 came from
    // public-1. Without it the flow would create "Abstract Architecture 2".
    const sources: Record<string, CloudSceneSource> = { "rt-1": { scene_id: "public-1", scene_version: null } };
    const form = [sanitizedCopy(storedScene("rt-1", "Abstract Architecture"))];
    await persistAndPushCloudFrameScenes(frameId, form, null, { sceneUnchanged: workspaceEquality, sources });

    expect(store.created).toEqual([]);
    expect(store.assignments.map((row) => row.scene_id)).toEqual(["public-1"]);
  });

  it("claims a stub tile (store id standing in for the runtime id) too", async () => {
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Abstract Architecture")], owned: false, version: 3 });
    store.assignments = [{ scene_id: "public-1", name: "Abstract Architecture" }];
    installFetch(store, { scenesJsonStatus: () => 429 });

    const stub = { id: "public-1", name: "Abstract Architecture", nodes: [], edges: [] } as unknown as FrameScene;
    await persistAndPushCloudFrameScenes(frameId, [stub], null, { sceneUnchanged: workspaceEquality });

    expect(store.created).toEqual([]);
    expect(store.assignments.map((row) => row.scene_id)).toEqual(["public-1"]);
  });

  it("ignores the Templates panel's origin stamp and never persists it", async () => {
    // The stored copy still carries a legacy stamp (version 6); a re-install
    // stamped the form with 7. Content is identical — nothing to publish.
    const store = fakeStore();
    const storedWithOrigin = {
      ...storedScene("rt-1", "Abstract Architecture"),
      origin: { repositoryId: "system-cloud-store", templateId: "abstract-architecture", version: "6" },
    } as unknown as FrameScene;
    store.scenes.set("public-1", { scenes: [storedWithOrigin], owned: false, version: 7 });
    store.assignments = [{ scene_id: "public-1" }];
    installFetch(store);

    const form = {
      ...sanitizedCopy(storedScene("rt-1", "Abstract Architecture")),
      origin: { repositoryId: "system-cloud-store", templateId: "abstract-architecture", version: "7" },
    } as unknown as FrameScene;
    await persistAndPushCloudFrameScenes(frameId, [form], null, { sceneUnchanged: workspaceEquality });
    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);

    // A genuinely new scene carrying a stamp is created WITHOUT it.
    const fresh = {
      id: "rt-new",
      name: "My scene",
      nodes: [],
      edges: [],
      origin: { repositoryId: "system-cloud-store", templateId: "x", version: "1" },
    } as unknown as FrameScene;
    await persistAndPushCloudFrameScenes(frameId, [form, fresh], null, { sceneUnchanged: workspaceEquality });
    expect(store.created).toEqual(["My scene"]);
    expect(store.scenes.get("new-1")?.scenes[0]).not.toHaveProperty("origin");
  });

  it("creates a genuinely new scene once, even when two saves race", async () => {
    const store = fakeStore();
    installFetch(store);
    const fresh = { id: "rt-new", name: "My scene", nodes: [], edges: [] } as unknown as FrameScene;

    // Two clicks in one second. Serialized, the second run lists the
    // assignment the first one wrote (whose scenes.json carries rt-new) and
    // finds nothing left to create.
    await Promise.all([
      persistAndPushCloudFrameScenes(frameId, [fresh], null, { sceneUnchanged: workspaceEquality }),
      persistAndPushCloudFrameScenes(frameId, [fresh], null, { sceneUnchanged: workspaceEquality }),
    ]);

    expect(store.created).toEqual(["My scene"]);
    expect(store.assignments.map((row) => row.scene_id)).toEqual(["new-1"]);
    expect(store.pushes).toHaveLength(2);
  });
});

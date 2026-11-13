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
  assignments: {
    scene_id: string;
    scene_version?: number | null;
    assigned_version?: number | null;
    latest_version?: number | null;
    name?: string;
  }[];
  // `scenes` is the newest version; `history` holds older ones by number.
  scenes: Map<
    string,
    { scenes: FrameScene[]; owned: boolean; version: number; history?: Record<number, FrameScene[]> }
  >;
  created: string[];
  updated: string[];
  pushes: unknown[];
  // Every store scene whose scenes.json the save read back, in order.
  read: string[];
  nextId: number;
};

function fakeStore(): Store {
  return { assignments: [], scenes: new Map(), created: [], updated: [], pushes: [], read: [], nextId: 1 };
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
      store.read.push(match[1]!);
      const status = options.scenesJsonStatus?.(match[1]!) ?? 200;
      if (status !== 200) {
        return new Response("{}", { status });
      }
      const entry = store.scenes.get(match[1]!);
      const asked = Number(url.searchParams.get("version") ?? 0);
      const served = asked && asked !== entry?.version ? entry?.history?.[asked] : entry?.scenes;
      return served ? Response.json(served) : new Response("{}", { status: 404 });
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

  it("compares the form with the version the frame HOLDS, not the store's latest", async () => {
    // The frame was sent v3; the publisher has since shipped v5 (the
    // workspace shows "Update available"). The form holds v3's content, so a
    // comparison against v5 read every such scene as edited: a save forked
    // the public install and republished the owned scene's OLD content on
    // top of its newer version.
    const store = fakeStore();
    const v5 = storedScene("rt-1", "Abstract Architecture");
    v5.nodes = [...v5.nodes, { id: "new-in-v5", type: "app", data: {} } as never];
    store.scenes.set("public-1", {
      history: { 3: [storedScene("rt-1", "Abstract Architecture")] },
      owned: false,
      scenes: [v5],
      version: 5,
    });
    const mineV2 = storedScene("rt-2", "Clock");
    mineV2.nodes = [];
    store.scenes.set("mine-1", { history: { 1: [storedScene("rt-2", "Clock")] }, owned: true, scenes: [mineV2], version: 2 });
    store.assignments = [
      { assigned_version: 3, latest_version: 5, scene_id: "public-1" },
      { assigned_version: 1, latest_version: 2, scene_id: "mine-1", scene_version: 1 },
    ];
    installFetch(store);

    const form = [sanitizedCopy(storedScene("rt-1", "Abstract Architecture")), sanitizedCopy(storedScene("rt-2", "Clock"))];
    const outcome = await persistAndPushCloudFrameScenes(frameId, form, null, { sceneUnchanged: workspaceEquality });

    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);
    expect(outcome.changedStoreSceneIds).toEqual([]);
    // Pins stay where they were: the save is not an update.
    expect(store.assignments).toEqual([
      { scene_id: "public-1", scene_version: null },
      { scene_id: "mine-1", scene_version: 1 },
    ]);
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

  it("marks only the scene it edited as `latest`: the push moves nothing else", async () => {
    // The server re-sends an unpinned scene at the version the frame holds
    // unless the entry says `latest` — so the edit has to say it, and a
    // bystander with a pending update must not.
    const store = fakeStore();
    store.scenes.set("mine-1", { scenes: [storedScene("rt-1", "Clock")], owned: true, version: 1 });
    store.scenes.set("public-1", {
      history: { 3: [storedScene("rt-2", "Abstract Architecture")] },
      owned: false,
      scenes: [storedScene("rt-2", "Abstract Architecture v5")],
      version: 5,
    });
    store.assignments = [{ scene_id: "mine-1" }, { assigned_version: 3, latest_version: 5, scene_id: "public-1" }];
    installFetch(store);

    const editedMine = sanitizedCopy(storedScene("rt-1", "Clock"));
    editedMine.nodes = [];
    await persistAndPushCloudFrameScenes(
      frameId,
      [editedMine, sanitizedCopy(storedScene("rt-2", "Abstract Architecture"))],
      null,
      { sceneUnchanged: workspaceEquality },
    );

    expect(store.updated).toEqual(["mine-1"]);
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([
      { latest: true, scene_id: "mine-1" },
      { scene_id: "public-1" },
    ]);
  });

  it("moves the named unedited scenes that have a newer version, a pin re-pinned, and no other", async () => {
    // The deploy drawer's deploys: the store has v5 of a public install the
    // frame holds at v3 and v2 of a pinned scene of the account's own. Both
    // go out at their newest, the up-to-date scene stays, and nothing is
    // published or forked for it.
    const store = fakeStore();
    store.scenes.set("public-1", {
      history: { 3: [storedScene("rt-1", "Abstract Architecture")] },
      owned: false,
      scenes: [storedScene("rt-1", "Abstract Architecture v5")],
      version: 5,
    });
    store.scenes.set("mine-1", {
      history: { 1: [storedScene("rt-2", "Clock")] },
      owned: true,
      scenes: [storedScene("rt-2", "Clock v2")],
      version: 2,
    });
    store.scenes.set("mine-2", { scenes: [storedScene("rt-3", "Weather")], owned: true, version: 4 });
    // Has an update too, but the owner unticked it in the drawer.
    store.scenes.set("public-2", {
      history: { 1: [storedScene("rt-4", "Moon")] },
      owned: false,
      scenes: [storedScene("rt-4", "Moon v2")],
      version: 2,
    });
    store.assignments = [
      { assigned_version: 3, latest_version: 5, scene_id: "public-1" },
      { assigned_version: 1, latest_version: 2, scene_id: "mine-1", scene_version: 1 },
      { assigned_version: 4, latest_version: 4, scene_id: "mine-2" },
      { assigned_version: 1, latest_version: 2, scene_id: "public-2" },
    ];
    installFetch(store);

    const form = [
      sanitizedCopy(storedScene("rt-1", "Abstract Architecture")),
      sanitizedCopy(storedScene("rt-2", "Clock")),
      sanitizedCopy(storedScene("rt-3", "Weather")),
      sanitizedCopy(storedScene("rt-4", "Moon")),
    ];
    const outcome = await persistAndPushCloudFrameScenes(frameId, form, null, {
      sceneUnchanged: workspaceEquality,
      updateStoreSceneIds: ["public-1", "mine-1", "mine-2"],
    });

    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);
    expect(outcome.updatedToLatest).toEqual({ "mine-1": 2, "public-1": 5 });
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([
      { latest: true, scene_id: "public-1" },
      { scene_id: "mine-1", scene_version: 2 },
      { scene_id: "mine-2" },
      { scene_id: "public-2" },
    ]);
  });

  it("without updateStoreSceneIds a save reports no updates and moves nothing", async () => {
    const store = fakeStore();
    store.scenes.set("public-1", {
      history: { 3: [storedScene("rt-1", "Abstract Architecture")] },
      owned: false,
      scenes: [storedScene("rt-1", "Abstract Architecture v5")],
      version: 5,
    });
    store.assignments = [{ assigned_version: 3, latest_version: 5, scene_id: "public-1" }];
    installFetch(store);

    const outcome = await persistAndPushCloudFrameScenes(
      frameId,
      [sanitizedCopy(storedScene("rt-1", "Abstract Architecture"))],
      null,
      { sceneUnchanged: workspaceEquality },
    );

    expect(outcome.updatedToLatest).toEqual({});
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([{ scene_id: "public-1" }]);
  });

  it("posts the install's button map beside the scene and never as scene content", async () => {
    // docs/events.md "Event map": the map is the install's, so a form scene
    // that only gained one is not an edit (no new version, no fork), the
    // push carries it as the assignment's event_maps, and taking it away
    // posts null so the row is cleared. A frame with none says nothing.
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Abstract Architecture")], owned: false, version: 3 });
    store.scenes.set("mine-1", { scenes: [storedScene("rt-2", "Clock")], owned: true, version: 1 });
    store.assignments = [{ scene_id: "public-1" }, { scene_id: "mine-1" }];
    installFetch(store);
    const rule = { event: "button", match: { label: "REFRESH", action: "press" }, as: { label: "A" } };

    const mapped = { ...sanitizedCopy(storedScene("rt-1", "Abstract Architecture")), eventMap: [rule] };
    await persistAndPushCloudFrameScenes(frameId, [mapped, sanitizedCopy(storedScene("rt-2", "Clock"))], null, {
      sceneUnchanged: workspaceEquality,
    });
    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([
      { scene_id: "public-1", event_maps: { "rt-1": [rule] } },
      { scene_id: "mine-1" },
    ]);

    // The row now holds a map; a form without one clears it. An edit to the
    // owned scene publishes without the map inside the content.
    store.assignments = [{ scene_id: "public-1", event_maps: { "rt-1": [rule] } } as never, { scene_id: "mine-1" }];
    const editedMine = { ...sanitizedCopy(storedScene("rt-2", "Clock")), eventMap: [rule] };
    editedMine.nodes = [];
    await persistAndPushCloudFrameScenes(
      frameId,
      [sanitizedCopy(storedScene("rt-1", "Abstract Architecture")), editedMine],
      null,
      { sceneUnchanged: workspaceEquality },
    );
    expect(store.updated).toEqual(["mine-1"]);
    expect(store.scenes.get("mine-1")?.scenes[0]).not.toHaveProperty("eventMap");
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([
      { scene_id: "public-1", event_maps: null },
      { latest: true, scene_id: "mine-1", event_maps: { "rt-2": [rule] } },
    ]);
  });

  it("posts the install's layout beside the scene and never as scene content", async () => {
    // docs/scene-layouts.md: the layout is the install's, like the button map.
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Clock")], owned: false, version: 3 });
    store.assignments = [{ scene_id: "public-1" }];
    installFetch(store);
    const layout = { sceneId: "bar", state: { height: 40 } };

    const wearing = { ...sanitizedCopy(storedScene("rt-1", "Clock")), layout };
    await persistAndPushCloudFrameScenes(frameId, [wearing], null, { sceneUnchanged: workspaceEquality });
    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([
      { scene_id: "public-1", layouts: { "rt-1": layout } },
    ]);

    store.assignments = [{ scene_id: "public-1", layouts: { "rt-1": layout } } as never];
    await persistAndPushCloudFrameScenes(frameId, [sanitizedCopy(storedScene("rt-1", "Clock"))], null, {
      sceneUnchanged: workspaceEquality,
    });
    expect((store.pushes.at(-1) as { scenes: unknown[] }).scenes).toEqual([{ scene_id: "public-1", layouts: null }]);
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

  // The scene drawer's "Push & activate" (frameLogic.saveScenes): reading
  // every assignment's scenes.json back, one request each, was most of a
  // push's time on a frame with twenty scenes.
  it("pushes one scene: reads its own pack alone, posts the rest as they are, shows it with its values", async () => {
    const store = fakeStore();
    store.scenes.set("public-1", { scenes: [storedScene("rt-1", "Weather")], owned: false, version: 3 });
    store.scenes.set("mine-1", { scenes: [storedScene("rt-2", "Clock")], owned: true, version: 1 });
    store.scenes.set("mine-2", { scenes: [storedScene("rt-3", "Steps")], owned: true, version: 2 });
    store.assignments = [{ scene_id: "public-1" }, { scene_id: "mine-1" }, { scene_id: "mine-2", scene_version: 2 }];
    installFetch(store);
    const sources: Record<string, CloudSceneSource> = {
      "rt-1": { scene_id: "public-1", scene_version: null },
      "rt-2": { scene_id: "mine-1", scene_version: null },
      "rt-3": { scene_id: "mine-2", scene_version: 2 },
    };
    const edited = {
      ...sanitizedCopy(storedScene("rt-2", "Clock")),
      nodes: [{ id: "rt-2-new", type: "event", data: { keyword: "render" } }],
    } as unknown as FrameScene;
    // Another unsaved scene in the form is not this push's to create.
    const other = { id: "rt-other", name: "Draft", nodes: [], edges: [] } as unknown as FrameScene;
    const form = [
      sanitizedCopy(storedScene("rt-1", "Weather")),
      edited,
      sanitizedCopy(storedScene("rt-3", "Steps")),
      other,
    ];

    await persistAndPushCloudFrameScenes(frameId, form, "rt-2", {
      sceneUnchanged: workspaceEquality,
      sources,
      only: ["rt-2"],
      activeState: { city: "Brussels" },
    });

    expect(store.read).toEqual(["mine-1"]);
    expect(store.updated).toEqual(["mine-1"]);
    expect(store.created).toEqual([]);
    const push = store.pushes.at(-1) as { scenes: Record<string, unknown>[]; scene_id?: string; state?: unknown };
    expect(push.scene_id).toBe("rt-2");
    expect(push.state).toEqual({ city: "Brussels" });
    // Order kept; the untouched rows go out as they were (pin and all), with
    // no maps or layouts said, which keeps the ones they have.
    expect(push.scenes.map((row) => row.scene_id)).toEqual(["public-1", "mine-1", "mine-2"]);
    expect(push.scenes[0]).toEqual({ scene_id: "public-1" });
    expect(push.scenes[2]).toEqual({ scene_id: "mine-2", scene_version: 2 });
  });

  it("a pushed scene the hydration did not place reads every pack, so it is created once", async () => {
    const store = fakeStore();
    store.scenes.set("mine-1", { scenes: [storedScene("rt-2", "Clock")], owned: true, version: 1 });
    store.assignments = [{ scene_id: "mine-1" }];
    installFetch(store);
    const fresh = { id: "rt-new", name: "My scene", nodes: [], edges: [] } as unknown as FrameScene;
    const other = { id: "rt-other", name: "Draft", nodes: [], edges: [] } as unknown as FrameScene;

    await persistAndPushCloudFrameScenes(frameId, [sanitizedCopy(storedScene("rt-2", "Clock")), fresh, other], "rt-new", {
      sceneUnchanged: workspaceEquality,
      sources: {},
      only: ["rt-new"],
    });

    expect(store.read).toEqual(["mine-1"]);
    expect(store.created).toEqual(["My scene"]);
    expect(store.assignments.map((row) => row.scene_id)).toEqual(["mine-1", "new-1"]);
    expect((store.pushes.at(-1) as { scene_id?: string }).scene_id).toBe("rt-new");
  });
});

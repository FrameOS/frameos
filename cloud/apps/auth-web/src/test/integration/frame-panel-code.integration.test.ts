// The code editor on a frame's own screen (docs/code-editor.md "The plane"):
// what the frame asks of the cloud with its enrollment bearer. `ask` runs the
// voice chat's scene builder on a typed request (the model scripted, as the
// voice suite scripts it) and saves nothing; `save` puts one scene on the
// frame's list the way the workspace's save does — a new version of the
// account's own private scene, a private copy of a public one, a new private
// scene for a new id — keeping the assignment's button maps and layout,
// granting nothing, and refusing a save that widens what the scene may do.
import { generateKeyPairSync } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  createDb,
  frameCommands,
  frameSceneAssignments,
  frames,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseInputItem, ResponsesToolDefinition } from "../../lib/ai/openai";

const cookieJar = vi.hoisted(() => new Map<string, string>());
const script = vi.hoisted(() => ({
  requests: [] as { input: ResponseInputItem[]; instructions: string; tools: ResponsesToolDefinition[] }[],
  rounds: [] as { text: string; calls: { name: string; arguments: Record<string, unknown>; call_id: string }[] }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("../../lib/ai/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ai/openai")>();
  return {
    ...actual,
    streamResponse: async ({
      input,
      instructions,
      tools,
      onTextDelta,
    }: {
      input: ResponseInputItem[];
      instructions: string;
      tools: ResponsesToolDefinition[];
      onTextDelta: (delta: string) => void;
    }) => {
      script.requests.push({ input: JSON.parse(JSON.stringify(input)), instructions, tools });
      const round = script.rounds[script.requests.length - 1] ?? { calls: [], text: "" };
      if (round.text) {
        onTextDelta(round.text);
      }
      const functionCalls = round.calls.map((call) => ({
        arguments: JSON.stringify(call.arguments),
        call_id: call.call_id,
        name: call.name,
        type: "function_call" as const,
      }));
      return {
        functionCalls,
        output: [
          ...(round.text
            ? [{ content: [{ text: round.text, type: "output_text" }], role: "assistant", type: "message" }]
            : []),
          ...functionCalls,
        ],
        outputText: round.text,
        status: "completed",
        usage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      };
    },
  };
});

// The builder's render check needs the wasm renderer; this suite checks the
// plumbing around a scripted scene AI, not a render.
vi.mock("../../lib/scene-render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/scene-render")>();
  return { ...actual, rendererAvailable: () => false };
});

import { POST as mintClaimToken } from "../../../app/api/frames/claim-tokens/route";
import { POST as enrollFrame } from "../../../app/api/frames/enroll/route";
import { POST as confirmFrame } from "../../../app/api/frames/[frameId]/confirm/route";
import { POST as assignFrameScenes } from "../../../app/api/frames/[frameId]/scenes/route";
import { POST as panelCode } from "../../../app/api/frames/[frameId]/panel/code/route";
import { POST as saveAccountSettings } from "../../../app/api/settings/route";
import { waitForPendingAiMetering } from "../../lib/billing";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;
let sceneCounter = 0;

afterAll(async () => {
  await waitForPendingAiMetering();
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  script.requests.length = 0;
  script.rounds.length = 0;
  await waitForPendingAiMetering();
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
});

function postJson(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

const routeParams = (frameId: string) => ({ params: Promise.resolve({ frameId }) });

async function account(name: string) {
  userCounter += 1;
  const providerSubject = `code-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: name,
    email: `code-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  return { accountId, providerSubject };
}

async function signIn() {
  const { accountId, providerSubject } = await account(`Owner ${userCounter + 1}`);
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function devicePublicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

function scene(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    edges: [{ id: "e", source: "render", sourceHandle: "next", target: "t", targetHandle: "prev" }],
    id,
    name,
    nodes: [
      { data: { keyword: "render" }, id: "render", type: "event" },
      { data: { config: { text: name }, keyword: "render/text" }, id: "t", type: "app" },
    ],
    settings: { execution: "interpreted" },
    ...extra,
  };
}

// A JS app asking for `permissions` and `settings` in its config.json.
function withApp(base: Record<string, unknown>, permissions: string[], settings: string[] = []) {
  return {
    ...base,
    apps: {
      helper: {
        sources: {
          "app.ts": "export function get() { return 'hi' }",
          "config.json": JSON.stringify({ name: "Helper", permissions, settings }),
        },
      },
    },
  };
}

// A public store scene of another account, one version.
async function publicStoreScene(name: string, scenes: Record<string, unknown>[]) {
  const { accountId } = await account("Publisher");
  sceneCounter += 1;
  const [row] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name,
      riskFlags: [],
      slug: `code-scene-${sceneCounter}`,
      status: "active",
      visibility: "public",
    })
    .returning();
  if (!row) {
    throw new Error("scene insert failed");
  }
  await db.insert(storeSceneVersions).values({
    content: Buffer.from(
      zipSync({
        "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)),
        "scene/template.json": new TextEncoder().encode(JSON.stringify({ name, scenes: "./scenes.json" })),
      }),
    ),
    contentType: "application/zip",
    riskFlags: [],
    sceneId: row.id,
    sha256: `code-${row.id}-1`,
    sizeBytes: 1000,
    version: 1,
  });
  return row.id;
}

// Enroll → confirm → active: an ESP32 frame, the way a real one arrives.
async function activeFrame() {
  const accountId = await signIn();
  const mint = await mintClaimToken(postJson("/api/frames/claim-tokens", { name: "Desk" }, { origin: baseUrl }));
  expect(mint.status).toBe(200);
  const { claim_token } = (await mint.json()) as { claim_token: string };
  const enroll = await enrollFrame(
    postJson("/api/frames/enroll", {
      claim_token,
      frameos_version: "2026.11.10",
      hardware: { height: 480, platform: "esp32-s3", width: 800 },
      public_key: devicePublicKey(),
    }),
  );
  expect(enroll.status).toBe(200);
  const payload = (await enroll.json()) as { access_token: string; frame_id: string };
  const confirm = await confirmFrame(
    postJson(`/api/frames/${payload.frame_id}/confirm`, {}, { origin: baseUrl }),
    routeParams(payload.frame_id),
  );
  expect(confirm.status).toBe(200);
  return { accountId, ...payload };
}

async function saveOpenAiKey() {
  const response = await saveAccountSettings(
    postJson("/api/settings", { openAI: { backendApiKey: "sk-code-test" } }, { origin: baseUrl }),
  );
  expect(response.status).toBe(200);
}

function code(frameId: string, token: string, body: Record<string, unknown>) {
  return panelCode(
    postJson(`/api/frames/${frameId}/panel/code`, body, { authorization: `Bearer ${token}` }),
    routeParams(frameId),
  );
}

async function assignments(frameId: string) {
  return db
    .select()
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(frameSceneAssignments.position);
}

async function newestPush(frameId: string) {
  const [row] = await db
    .select({ payload: frameCommands.payload })
    .from(frameCommands)
    .where(and(eq(frameCommands.frameId, frameId), eq(frameCommands.type, "set_scenes")))
    .orderBy(desc(frameCommands.createdAt), desc(frameCommands.id))
    .limit(1);
  return row?.payload as
    | { scene_id?: string; scenes: { id: string; name: string; default?: boolean; eventMap?: unknown; nodes: { data: { config?: { text?: string } } }[]; origin?: { storeSceneId?: string; version?: string } }[] }
    | undefined;
}

describe("POST /api/frames/{id}/panel/code: ask", () => {
  it("builds a new scene from a typed request with the voice chat's scene AI, and saves nothing", async () => {
    const frame = await activeFrame();
    await saveOpenAiKey();
    const built = scene("33333333-3333-4333-8333-333333333333", "Big clock");
    script.rounds.push(
      { calls: [{ arguments: { scenes: [built], title: "Clock" }, call_id: "s1", name: "create_scenes" }], text: "" },
      { calls: [], text: "A clock with the time in big digits." },
    );
    const response = await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "a clock with big digits" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; scene: { id: string; name: string }; summary: string };
    expect(body).toMatchObject({ ok: true, summary: "A clock with the time in big digits." });
    expect(body.scene).toMatchObject({ id: built.id, name: "Big clock" });
    // The builder's tools alone, and the request said to be typed.
    const first = script.requests[0]!;
    expect(first.tools.map((tool) => tool.name)).toContain("create_scenes");
    expect(first.tools.map((tool) => tool.name)).not.toContain("save_scene");
    const context = (first.input[0]!.content as { text: string }[])[0]!.text;
    expect(context).toContain("The typed request: a clock with big digits");
    expect(context).toContain("typed, on the frame's screen");
    expect(context).not.toContain("spoken");
    expect(context).toContain("Resolution: 800x480");
    // Nothing saved, nothing pushed.
    expect(await assignments(frame.frame_id)).toEqual([]);
    expect(await newestPush(frame.frame_id)).toBeUndefined();
    expect(await db.select().from(storeScenes)).toEqual([]);
  });

  it("changes the scene it is given and keeps its id", async () => {
    const frame = await activeFrame();
    await saveOpenAiKey();
    const base = { ...scene("kitchen-rt", "Kitchen"), eventMap: [{ event: "button", as: { role: "next" } }], origin: { storeSceneId: "x" } };
    const changed = scene("some-other-id", "Kitchen, bigger");
    script.rounds.push(
      { calls: [{ arguments: { scenes: [changed], title: "Kitchen" }, call_id: "s1", name: "create_scenes" }], text: "" },
      { calls: [], text: "Bigger text." },
    );
    const response = await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "make it bigger", scene: base });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scene: { id: string; name: string } };
    expect(body.scene).toMatchObject({ id: "kitchen-rt", name: "Kitchen, bigger" });
    const context = (script.requests[0]!.input[0]!.content as { text: string }[])[0]!.text;
    expect(context).toContain("The typed request: make it bigger");
    // The install's bookkeeping is not the model's to see.
    expect(context).toContain('"id":"kitchen-rt"');
    expect(context).not.toContain("eventMap");
    expect(context).not.toContain("storeSceneId");
  });

  it("hands the scene AI 2,000 characters at most, and says when it built nothing", async () => {
    const frame = await activeFrame();
    await saveOpenAiKey();
    script.rounds.push({ calls: [], text: "I could not." });
    const response = await code(frame.frame_id, frame.access_token, { action: "ask", prompt: `${"x".repeat(2000)}yz` });
    // The frame reads the code: 200, as the voice route answers.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ detail: "I could not.", error: "no_scene", ok: false });
    const context = (script.requests[0]!.input[0]!.content as { text: string }[])[0]!.text;
    expect(context).toContain(`The typed request: ${"x".repeat(2000)}\n`);
    expect(context).not.toContain("xy");
  });

  it("says when there is no AI, and refuses what is not a request", async () => {
    const frame = await activeFrame();
    const noKey = await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "a clock" });
    expect(await noKey.json()).toMatchObject({ error: "ai_unavailable", ok: false });
    expect(script.requests).toEqual([]);

    const empty = await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "  " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "empty_prompt", ok: false });
    expect(await (await code(frame.frame_id, frame.access_token, { action: "ask", prompt: 7 })).json()).toMatchObject({
      error: "empty_prompt",
    });
    expect(
      await (await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "a", scene: "nope" })).json(),
    ).toMatchObject({ error: "invalid_scene" });

    // Twenty asks an hour per frame (counted before anything runs).
    for (let i = 0; i < 16; i += 1) {
      await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "a clock" });
    }
    const limited = await code(frame.frame_id, frame.access_token, { action: "ask", prompt: "a clock" });
    expect(limited.status).toBe(429);
    // A save counts elsewhere.
    expect((await code(frame.frame_id, frame.access_token, { action: "save", scene: {} })).status).toBe(400);
  });
});

describe("POST /api/frames/{id}/panel/code: save", () => {
  it("adds a new scene as a private scene of the account, granted nothing, and shows it", async () => {
    const frame = await activeFrame();
    const added = scene("new-rt", "Notes");
    const response = await code(frame.frame_id, frame.access_token, { action: "save", scene: { ...added, default: true } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; scene_id: string; store_scene_id: string; status: string };
    expect(body).toMatchObject({ ok: true, scene_id: "new-rt", status: "queued", version: 1 });
    const [row] = await db.select().from(storeScenes).where(eq(storeScenes.id, body.store_scene_id));
    expect(row).toMatchObject({ accountId: frame.accountId, name: "Notes", visibility: "private" });
    const rows = await assignments(frame.frame_id);
    expect(rows.map((entry) => entry.sceneId)).toEqual([body.store_scene_id]);
    expect(rows[0]!.grantedSettingsGroups ?? []).toEqual([]);
    const push = await newestPush(frame.frame_id);
    expect(push?.scene_id).toBe("new-rt");
    // Never the default: that mark is the frame's list's.
    expect(push?.scenes[0]).toMatchObject({ id: "new-rt", name: "Notes" });
    expect(push?.scenes[0]?.default).toBeUndefined();
  });

  it("replaces a scene of the account's own as a new version, keeping its default mark and button map", async () => {
    const frame = await activeFrame();
    const first = await code(frame.frame_id, frame.access_token, { action: "save", scene: scene("own-rt", "Clock") });
    const { store_scene_id: own } = (await first.json()) as { store_scene_id: string };
    const second = await code(frame.frame_id, frame.access_token, { action: "save", scene: scene("other-rt", "Other") });
    expect(second.status).toBe(200);
    // The owner's button map and default mark on the first.
    const rule = { as: { action: "press", label: "B", role: "next" }, event: "button", match: { action: "longPress", label: "REFRESH" } };
    await db
      .update(frameSceneAssignments)
      .set({ eventMaps: { "own-rt": [rule] } })
      .where(and(eq(frameSceneAssignments.frameId, frame.frame_id), eq(frameSceneAssignments.sceneId, own)));
    const [held] = await db.select().from(storeSceneVersions).where(eq(storeSceneVersions.sceneId, own));
    expect(held?.version).toBe(1);

    const edited = { ...scene("own-rt", "Clock, edited"), eventMap: [], origin: { storeSceneId: own, version: "1" } };
    const response = await code(frame.frame_id, frame.access_token, { action: "save", scene: edited, show: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, scene_id: "own-rt", store_scene_id: own, version: 2 });
    // The same store scene, a new version; no other scene was made.
    expect((await db.select().from(storeScenes)).length).toBe(2);
    const rows = await assignments(frame.frame_id);
    expect(rows.map((entry) => entry.sceneId)[0]).toBe(own);
    expect(rows[0]!.sceneVersion).toBeNull();
    expect(rows[0]!.eventMaps).toEqual({ "own-rt": [rule] });
    const push = await newestPush(frame.frame_id);
    const pushed = push?.scenes.find((entry) => entry.id === "own-rt");
    expect(pushed).toMatchObject({ name: "Clock, edited", origin: { storeSceneId: own, version: "2" } });
    expect(pushed?.eventMap).toEqual([rule]);
    // show: false stays on what the frame shows.
    expect(push?.scene_id).not.toBe("own-rt");
  });

  it("keeps the default mark of the scene it replaces", async () => {
    const frame = await activeFrame();
    const publicId = await publicStoreScene("Weather", [scene("weather-rt", "Weather", { default: true })]);
    const assigned = await assignFrameScenes(
      postJson(`/api/frames/${frame.frame_id}/scenes`, { scenes: [{ scene_id: publicId }] }, { origin: baseUrl }),
      routeParams(frame.frame_id),
    );
    expect(assigned.status).toBe(200);
    const response = await code(frame.frame_id, frame.access_token, {
      action: "save",
      scene: scene("weather-rt", "Weather, mine"),
    });
    expect(response.status).toBe(200);
    expect((await newestPush(frame.frame_id))?.scenes[0]).toMatchObject({ default: true, id: "weather-rt", name: "Weather, mine" });
  });

  it("makes a private copy of a public scene in its place, with its layout and button map", async () => {
    const frame = await activeFrame();
    const publicId = await publicStoreScene("Radar", [scene("radar-rt", "Radar"), scene("radar-panel", "Radar panel")]);
    const mine = await code(frame.frame_id, frame.access_token, { action: "save", scene: scene("mine-rt", "Mine") });
    const { store_scene_id: mineId } = (await mine.json()) as { store_scene_id: string };
    const rule = { as: { role: "next" }, event: "button", match: { label: "A" } };
    const assigned = await assignFrameScenes(
      postJson(
        `/api/frames/${frame.frame_id}/scenes`,
        { scenes: [{ event_maps: { "radar-rt": [rule] }, scene_id: publicId }, { scene_id: mineId }] },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    expect(assigned.status).toBe(200);

    const response = await code(frame.frame_id, frame.access_token, { action: "save", scene: scene("radar-rt", "My radar") });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { store_scene_id: string };
    expect(body.store_scene_id).not.toBe(publicId);
    const [copy] = await db.select().from(storeScenes).where(eq(storeScenes.id, body.store_scene_id));
    expect(copy).toMatchObject({ accountId: frame.accountId, visibility: "private" });
    const rows = await assignments(frame.frame_id);
    expect(rows.map((entry) => entry.sceneId)).toEqual([body.store_scene_id, mineId]);
    expect(rows[0]!.eventMaps).toEqual({ "radar-rt": [rule] });
    const push = await newestPush(frame.frame_id);
    // The pack's other scene comes along; the edited one shows.
    expect(push?.scenes.map((entry) => entry.id)).toEqual(["radar-rt", "radar-panel", "mine-rt"]);
    expect(push?.scenes[0]?.name).toBe("My radar");
    expect(push?.scene_id).toBe("radar-rt");
    // The publisher's scene is untouched.
    expect((await db.select().from(storeSceneVersions).where(eq(storeSceneVersions.sceneId, publicId))).length).toBe(1);
  });

  it("refuses a save that widens what the scene may do, and what is no scene", async () => {
    const frame = await activeFrame();
    // A new scene: no red permission, no settings key.
    const red = await code(frame.frame_id, frame.access_token, {
      action: "save",
      scene: withApp(scene("red-rt", "Red"), ["assets", "frame"], ["openAI"]),
    });
    expect(red.status).toBe(403);
    expect(await red.json()).toEqual({ error: "needs_owner", needs: ["frame", "key:openAI"], ok: false });
    // Leaving the list out is no way past it: the code asks for `frame`.
    const unlisted = withApp(scene("sneaky-rt", "Sneaky"), []);
    (unlisted.apps.helper.sources as Record<string, string>)["app.ts"] = "frameos.frame('reboot')";
    (unlisted.apps.helper.sources as Record<string, string>)["config.json"] = JSON.stringify({ name: "Helper" });
    expect(await (await code(frame.frame_id, frame.access_token, { action: "save", scene: unlisted })).json()).toMatchObject({
      error: "needs_owner",
      needs: ["frame"],
    });
    // What is not red is fine.
    const plain = await code(frame.frame_id, frame.access_token, {
      action: "save",
      scene: withApp(scene("plain-rt", "Plain"), ["assets"]),
    });
    expect(plain.status).toBe(200);
    // A saved scene keeps what it asked for, and asks for no more.
    const kept = await code(frame.frame_id, frame.access_token, {
      action: "save",
      scene: withApp(scene("plain-rt", "Plain, edited"), ["assets"]),
    });
    expect(kept.status).toBe(200);
    const wider = await code(frame.frame_id, frame.access_token, {
      action: "save",
      scene: withApp(scene("plain-rt", "Plain, wider"), ["assets", "assets-write"], ["unsplash"]),
    });
    expect(await wider.json()).toEqual({ error: "needs_owner", needs: ["assets-write", "key:unsplash"], ok: false });

    const refusal = async (body: Record<string, unknown>) => (await (await code(frame.frame_id, frame.access_token, body)).json()) as { error: string };
    expect((await refusal({ action: "save", scene: { name: "no id" } })).error).toBe("invalid_scene");
    expect((await refusal({ action: "save", scene: [] })).error).toBe("invalid_scene");
    expect((await refusal({ action: "save", scene: scene("system/sceneSwitcher", "Switcher") })).error).toBe("invalid_scene");
    expect((await refusal({ action: "save", scene: { ...scene("c-rt", "C"), settings: { execution: "compiled" } } })).error).toBe(
      "scene_requires_compilation",
    );
    expect(await refusal({ action: "save", scene: { ...scene("l-rt", "L"), settings: { execution: "interpreted", isLayout: true } } })).toEqual({
      detail: "render",
      error: "invalid_layout",
      ok: false,
    });
    // An app whose config.json only a lenient parser reads: the frame gives
    // it nothing, and what it asks for could be shown to nobody.
    const lenient = withApp(scene("lenient-rt", "Lenient"), []);
    (lenient.apps.helper.sources as Record<string, string>)["config.json"] = '{\n  // hidden\n  "permissions": ["frame"],\n}';
    expect(await refusal({ action: "save", scene: lenient })).toMatchObject({
      detail: expect.stringContaining('App "helper" in scene "Lenient": config.json is not valid JSON'),
      error: "invalid_app_config",
    });
    // The store's own permission is red too.
    const shop = await code(frame.frame_id, frame.access_token, {
      action: "save",
      scene: withApp(scene("shop-rt", "Shop"), ["store"]),
    });
    expect(await shop.json()).toEqual({ error: "needs_owner", needs: ["store"], ok: false });
    expect((await refusal({ action: "publish" })).error).toBe("invalid_action");
    // Nothing of the refused ones reached the frame's list.
    expect((await assignments(frame.frame_id)).length).toBe(1);
  });

  it("refuses another frame's token, and everything while the settings on the screen are off", async () => {
    const other = await activeFrame();
    const frame = await activeFrame();
    expect((await code(frame.frame_id, other.access_token, { action: "save", scene: scene("a", "A") })).status).toBe(403);
    expect((await code(frame.frame_id, "nope", { action: "save", scene: scene("a", "A") })).status).toBe(401);
    await db.update(frames).set({ settings: { frame_settings_on_screen: false } }).where(eq(frames.id, frame.frame_id));
    for (const body of [
      { action: "save", scene: scene("a", "A") },
      { action: "ask", prompt: "a clock" },
    ]) {
      const locked = await code(frame.frame_id, frame.access_token, body);
      expect(locked.status).toBe(403);
      expect(await locked.json()).toEqual({ error: "panel_locked", ok: false });
    }
    expect(await assignments(frame.frame_id)).toEqual([]);
  });
});

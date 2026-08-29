// The AI chat on the scene store, against a real database.
//
// Three things the store surface added. The chat route builds a context
// block for the store scene the user is looking at — with the right saving
// story (own scene: new version; someone else's: fork) — and refuses to
// describe a private scene the user cannot read. save_scene forks THAT scene
// by default, so a "keep this" on a remix records lineage and keeps the
// preview image. And the delivery tools lint against the app catalog: a
// hallucinated config key never reaches the editor, while an edit to a scene
// that already carried a legacy value is judged only on what it changed.

import { and, eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import {
  accountSettings,
  auditEvents,
  createDb,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookieName } from "../../lib/session";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { executeTool, type ScenesEvent, type ToolContext } from "../../lib/ai/tools";
import type { ResponseInputItem } from "../../lib/ai/openai";

const cookieJar = vi.hoisted(() => new Map<string, string>());
const capturedInputs = vi.hoisted(() => [] as ResponseInputItem[][]);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));

// The model is not under test: answer every call with plain text and record
// what it was shown.
vi.mock("../../lib/ai/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ai/openai")>();
  return {
    ...actual,
    streamResponse: async ({
      input,
      onTextDelta,
    }: {
      input: ResponseInputItem[];
      onTextDelta: (delta: string) => void;
    }) => {
      capturedInputs.push(structuredClone(input));
      onTextDelta("ok");
      return {
        functionCalls: [],
        output: [],
        outputText: "ok",
        status: "completed",
        usage: actual.emptyUsage(),
      };
    },
  };
});

import { POST as chatRoute } from "../../../app/api/ai/chat/route";

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;
let sceneCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  capturedInputs.length = 0;
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

async function signIn(withKey = true) {
  userCounter += 1;
  const providerSubject = `store-ai-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Store AI User ${userCounter}`,
    email: `store-ai-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  if (withKey) {
    await db.insert(accountSettings).values({
      accountId,
      key: "openAI",
      value: { backendApiKey: "sk-test" },
    });
  }
  return { accountId, providerSubject };
}

function renderScene(id: string, name: string, textConfig: Record<string, string> = { text: "hi" }) {
  return {
    edges: [
      { id: `${id}-e1`, source: `${id}-ev`, sourceHandle: "next", target: `${id}-text`, targetHandle: "prev", type: "appNodeEdge" },
    ],
    fields: [],
    id,
    name,
    nodes: [
      { data: { keyword: "render" }, id: `${id}-ev`, type: "event" },
      { data: { config: textConfig, keyword: "render/text" }, id: `${id}-text`, type: "app" },
    ],
    settings: { execution: "interpreted" },
  };
}

async function storeScene(
  accountId: string,
  options: { name: string; visibility?: "private" | "public"; scenes?: unknown[] },
) {
  sceneCounter += 1;
  const scenes = options.scenes ?? [renderScene(`source-${sceneCounter}`, options.name)];
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const zip = Buffer.from(
    zipSync({
      "scene/scenes.json": encode(scenes),
      "scene/template.json": encode({ name: options.name, scenes: "./scenes.json" }),
    }),
  );
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      category: "utilities",
      description: "Counts things",
      latestVersion: 1,
      name: options.name,
      previewImage: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 7]),
      previewImageType: "image/jpeg",
      slug: `${options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sceneCounter}`,
      status: "active",
      tags: ["counter"],
      visibility: options.visibility ?? "public",
    })
    .returning();
  await db.insert(storeSceneVersions).values({
    content: zip,
    contentType: "application/zip",
    riskFlags: [],
    sceneId: scene!.id,
    sha256: `sha-${sceneCounter}`,
    sizeBytes: zip.length,
    version: 1,
  });
  return { scene: scene!, scenes };
}

async function chat(body: Record<string, unknown>) {
  const request = new NextRequest(new URL("/api/ai/chat", baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
  const response = await chatRoute(request);
  const text = await response.text();
  return { response, text };
}

function contextShownToModel(): string {
  const input = capturedInputs[0] ?? [];
  const first = input[0] as { content?: { text?: string }[] } | undefined;
  return first?.content?.[0]?.text ?? "";
}

describe("AI chat on a store scene", () => {
  it("tells the model whose scene it is and how saving works (someone else's: fork)", async () => {
    const owner = await signIn(false);
    const { scene } = await storeScene(owner.accountId, { name: "Big counter" });
    cookieJar.clear();
    await signIn();

    const { response, text } = await chat({
      prompt: "make it red",
      scene: renderScene("editor-1", "Big counter"),
      sceneId: "editor-1",
      storeSceneId: scene.id,
    });
    expect(response.status).toBe(200);
    expect(text).toContain('"type":"done"');

    const context = contextShownToModel();
    expect(context).toContain(`Store scene id: ${scene.id}`);
    expect(context).toContain("Name: Big counter");
    expect(context).toContain("Tags: counter");
    expect(context).toContain("does not own this scene");
    expect(context).toContain("FORK");
    expect(context).not.toContain("this is the user's own scene");
  });

  it("describes an owned scene as saveable in place", async () => {
    const { accountId } = await signIn();
    const { scene } = await storeScene(accountId, { name: "My counter" });

    await chat({ prompt: "hello", storeSceneId: scene.id });

    const context = contextShownToModel();
    expect(context).toContain("this is the user's own scene");
    expect(context).toContain("Save as new version");
  });

  it("does not leak a private scene the user cannot read", async () => {
    const owner = await signIn(false);
    const { scene } = await storeScene(owner.accountId, { name: "Secret counter", visibility: "private" });
    cookieJar.clear();
    await signIn();

    const { response } = await chat({ prompt: "hello", storeSceneId: scene.id });

    expect(response.status).toBe(200);
    expect(contextShownToModel()).not.toContain("Secret counter");
  });

  it("refuses without an OpenAI key unless the shared key is opened up", async () => {
    await signIn(false);
    const { response, text } = await chat({ prompt: "hello" });
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: "missing_api_key" });
  });
});

describe("save_scene on a store scene", () => {
  it("forks the store scene in context when no source is named", async () => {
    const owner = await signIn(false);
    const { scene: source, scenes } = await storeScene(owner.accountId, { name: "Big counter" });
    const forker = await signIn();

    const ctx: ToolContext = {
      accountId: forker.accountId,
      currentScene: scenes[0] as Record<string, unknown>,
      currentSceneId: (scenes[0] as { id: string }).id,
      db,
      emitScenes: () => undefined,
      prompt: "save this",
      providerSubject: forker.providerSubject,
      storeSceneId: source.id,
    };
    const result = JSON.parse(await executeTool("save_scene", {}, ctx)) as {
      ok: boolean;
      note: string;
      scene: { id: string };
    };
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/forked/i);

    const [saved] = await db.select().from(storeScenes).where(eq(storeScenes.id, result.scene.id));
    expect(saved).toMatchObject({
      accountId: forker.accountId,
      description: "Counts things",
      name: "Big counter (copy)",
      tags: ["counter"],
      visibility: "private",
    });
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "store.scene_forked"), eq(auditEvents.accountId, forker.accountId)));
    expect(event?.metadata).toMatchObject({ sourceSceneId: source.id, via: "ai_chat" });
  });
});

describe("update_scene_listing", () => {
  function listingCtx(accountId: string, storeSceneId: string | null): ToolContext {
    return {
      accountId,
      db,
      emitScenes: () => undefined,
      prompt: "update the description",
      storeSceneId,
    };
  }

  it("writes the description of the scene in context, leaving tags and category alone", async () => {
    const owner = await signIn(false);
    const { scene } = await storeScene(owner.accountId, { name: "Visited world map" });

    const result = JSON.parse(
      await executeTool(
        "update_scene_listing",
        { description: "Every country I have set foot in, in ink." },
        listingCtx(owner.accountId, scene.id),
      ),
    ) as { listing: { description: string }; note: string; ok: boolean };
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/does not need to press Save/);
    expect(result.note).toMatch(/made no new version/);

    const [row] = await db.select().from(storeScenes).where(eq(storeScenes.id, scene.id));
    expect(row).toMatchObject({
      category: "utilities",
      description: "Every country I have set foot in, in ink.",
      name: "Visited world map",
      tags: ["counter"],
    });

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "store.listing_edited"));
    expect(event?.metadata).toMatchObject({ fields: ["description"], via: "ai_chat" });
  });

  it("replaces tags and clears a category when asked", async () => {
    const owner = await signIn(false);
    const { scene } = await storeScene(owner.accountId, { name: "Visited world map" });

    const result = JSON.parse(
      await executeTool(
        "update_scene_listing",
        { category: null, scene_id: scene.id, tags: ["Maps", "travel"] },
        listingCtx(owner.accountId, null),
      ),
    ) as { ok: boolean };
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(storeScenes).where(eq(storeScenes.id, scene.id));
    expect(row).toMatchObject({
      category: null,
      description: "Counts things",
      tags: ["maps", "travel"],
    });
  });

  it("will not touch a listing the user does not own", async () => {
    const owner = await signIn(false);
    const { scene } = await storeScene(owner.accountId, { name: "Visited world map" });
    const visitor = await signIn(false);

    const result = JSON.parse(
      await executeTool(
        "update_scene_listing",
        { description: "mine now" },
        listingCtx(visitor.accountId, scene.id),
      ),
    ) as { error: string; ok: boolean };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in the user's account/);

    const [row] = await db.select().from(storeScenes).where(eq(storeScenes.id, scene.id));
    expect(row?.description).toBe("Counts things");
  });
});

describe("scene delivery lint", () => {
  function ctxWith(overrides: Partial<ToolContext>, events: ScenesEvent[]): ToolContext {
    return {
      accountId: "unused",
      db,
      emitScenes: (event) => {
        events.push(event);
      },
      prompt: "build it",
      ...overrides,
    };
  }

  it("bounces a scene whose config names a field the app does not have", async () => {
    const events: ScenesEvent[] = [];
    const output = JSON.parse(
      await executeTool(
        "create_scenes",
        { scenes: [renderScene("s1", "Bad", { text: "hi", fontSizePx: "40" })], title: "Bad" },
        ctxWith({}, events),
      ),
    ) as { ok: boolean; issues?: string[] };
    expect(output.ok).toBe(false);
    expect(output.issues?.join("\n")).toMatch(/no field "fontSizePx"/);
    expect(events).toHaveLength(0);
  });

  it("delivers a valid scene and reports warnings without blocking", async () => {
    const events: ScenesEvent[] = [];
    const scene = renderScene("s2", "Good");
    scene.nodes.push({ data: { config: { text: "orphan" }, keyword: "render/text" }, id: "s2-orphan", type: "app" });
    const output = JSON.parse(
      await executeTool("create_scenes", { scenes: [scene], title: "Good" }, ctxWith({}, events)),
    ) as { ok: boolean; warnings?: string[] };
    expect(output.ok).toBe(true);
    expect(output.warnings?.join("\n")).toMatch(/not connected/);
    expect(events).toHaveLength(1);
  });

  it("refuses a partial update that would silently delete most of the scene", async () => {
    const big = renderScene("s4", "Big");
    for (let i = 0; i < 6; i += 1) {
      big.nodes.push({ data: { config: { text: `t${i}` }, keyword: "render/text" }, id: `s4-extra-${i}`, type: "app" });
    }
    const partial = renderScene("s4", "Big", { text: "only this" });
    const events: ScenesEvent[] = [];
    const refused = JSON.parse(
      await executeTool(
        "update_scene",
        { scene: partial },
        ctxWith({ currentScene: big as Record<string, unknown>, currentSceneId: "s4" }, events),
      ),
    ) as { ok: boolean; issues?: string[] };
    expect(refused.ok).toBe(false);
    expect(refused.issues?.[0]).toMatch(/partial update/);
    expect(events).toHaveLength(0);

    const rewritten = JSON.parse(
      await executeTool(
        "update_scene",
        { rewrite: true, scene: partial },
        ctxWith({ currentScene: big as Record<string, unknown>, currentSceneId: "s4" }, events),
      ),
    ) as { ok: boolean };
    expect(rewritten.ok).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("judges an edit on what it changed, not on legacy values it inherited", async () => {
    // "position": "top-left" is not one of render/text's options, but old
    // store scenes carry it. Changing the text must still go through…
    const legacy = renderScene("s3", "Legacy", { position: "top-left", text: "old" });
    const edited = renderScene("s3", "Legacy", { position: "top-left", text: "new" });
    const events: ScenesEvent[] = [];
    const ok = JSON.parse(
      await executeTool(
        "update_scene",
        { scene: edited },
        ctxWith({ currentScene: legacy as Record<string, unknown>, currentSceneId: "s3" }, events),
      ),
    ) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(events).toHaveLength(1);

    // …while a NEW mistake in the same edit is still refused.
    const broken = renderScene("s3", "Legacy", { position: "top-left", text: "new", colour: "red" });
    const refused = JSON.parse(
      await executeTool(
        "update_scene",
        { scene: broken },
        ctxWith({ currentScene: legacy as Record<string, unknown>, currentSceneId: "s3" }, []),
      ),
    ) as { ok: boolean; issues?: string[] };
    expect(refused.ok).toBe(false);
    expect(refused.issues?.join("\n")).toMatch(/no field "colour"/);
    expect(refused.issues?.join("\n")).not.toMatch(/top-left/);
  });
});

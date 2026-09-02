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
  aiChatMessages,
  auditEvents,
  createDb,
  frames,
  frameSceneAssignments,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  aiUsageRecords,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookieName } from "../../lib/session";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { waitForPendingAiMetering } from "../../lib/billing";
import { executeTool, type ListingEvent, type ScenesEvent, type ToolContext } from "../../lib/ai/tools";
import type { ResponseInputItem } from "../../lib/ai/openai";

const cookieJar = vi.hoisted(() => new Map<string, string>());
const capturedInputs = vi.hoisted(() => [] as ResponseInputItem[][]);
// Function calls the fake model makes, one round per entry, consumed in
// order; the round after the last entry answers with plain text.
const scriptedCalls = vi.hoisted(
  () => [] as { name: string; arguments: Record<string, unknown> }[][],
);

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
      const round = scriptedCalls.shift();
      if (round && round.length > 0) {
        const functionCalls = round.map((call, index) => ({
          arguments: JSON.stringify(call.arguments),
          call_id: `call-${capturedInputs.length}-${index}`,
          name: call.name,
          type: "function_call" as const,
        }));
        return {
          functionCalls,
          output: functionCalls,
          outputText: "",
          status: "completed",
          usage: actual.emptyUsage(),
        };
      }
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
import { resetSpendReservationsForTests, reserveTurnSpend } from "../../lib/ai/spend-reservations";
import { maxHistoryItemChars } from "../../lib/ai/chat-store";

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
  resetSpendReservationsForTests();
  cookieJar.clear();
  capturedInputs.length = 0;
  scriptedCalls.length = 0;
  // A finished turn meters itself in the background, after the response has
  // been read: truncating while that insert is open deadlocks against it.
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
      previewImage: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 7, 0, 0, 0, 0, 0, 0, 0]),
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

  // §9.2 item 1 of cloud/docs/accounting-todo.md: the metered surface is the
  // gate's, never the client's. `scene_convert` is an absorbed surface —
  // free and uncapped — and a client used to be able to name it.
  it("meters the gate's surface, whatever the client claims", async () => {
    const { accountId } = await signIn();
    const { response } = await chat({ prompt: "hello", surface: "scene_convert" });
    expect(response.status).toBe(200);
    await waitForPendingAiMetering();

    const [record] = await db
      .select({ context: aiUsageRecords.context, surface: aiUsageRecords.surface })
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.accountId, accountId));
    expect(record).toEqual({ context: "scene_convert", surface: "scene_chat" });
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
  it("delivers a listing edit to the draft and writes nothing to the store", async () => {
    const owner = await signIn(false);
    const { scene } = await storeScene(owner.accountId, { name: "Visited world map" });
    const events: ListingEvent[] = [];

    const result = JSON.parse(
      await executeTool(
        "update_scene_listing",
        { description: "Every country I have set foot in, in ink.", tags: ["Maps", "travel"] },
        {
          accountId: owner.accountId,
          currentListing: { description: "Counts things", tags: ["counter"] },
          db,
          emitListing: (event) => {
            events.push(event);
          },
          emitScenes: () => undefined,
          prompt: "update the description",
          storeSceneId: scene.id,
        },
      ),
    ) as { listing: Record<string, unknown>; note: string; ok: boolean };
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      {
        listing: { description: "Every country I have set foot in, in ink.", tags: ["maps", "travel"] },
        type: "listing",
      },
    ]);
    expect(result.note).toMatch(/Save publishes it/);

    // The store is untouched until the user saves.
    const [row] = await db.select().from(storeScenes).where(eq(storeScenes.id, scene.id));
    expect(row).toMatchObject({ description: "Counts things", tags: ["counter"] });
  });

  it("shows the model the draft's listing, not the published one", async () => {
    const owner = await signIn();
    const { scene } = await storeScene(owner.accountId, { name: "Visited world map" });

    const { response } = await chat({
      listing: { description: "Draft text nobody saved yet", tags: ["maps"] },
      prompt: "improve the description",
      scene: renderScene("editor-1", "Visited world map"),
      sceneId: "editor-1",
      storeSceneId: scene.id,
    });
    expect(response.status).toBe(200);
    const context = contextShownToModel();
    expect(context).toContain("Listing description (the editor's draft): Draft text nobody saved yet");
    expect(context).toContain("Tags: maps");
    expect(context).not.toContain("Counts things");
    expect(context).toContain("update_scene_listing edits the draft, and Save publishes it");
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

// Everything the model reads about a store scene was written by its
// publisher; the tool result says so, in-band, where the text is.
describe("untrusted data framing", () => {
  it("wraps get_store_scene in an untrusted_data frame", async () => {
    const { accountId } = await signIn();
    const { scene } = await storeScene(accountId, { name: "Framed counter" });
    const output = await executeTool(
      "get_store_scene",
      { scene_id: scene.id },
      { accountId, db, emitScenes: () => undefined, prompt: "x" },
    );
    expect(output.startsWith('<untrusted_data source="store_scene">')).toBe(true);
    expect(output).toContain("UNTRUSTED DATA");
    expect(output).toContain("Framed counter");
    expect(output.trimEnd().endsWith("</untrusted_data>")).toBe(true);
  });

  it("wraps search_store_scenes too", async () => {
    const { accountId } = await signIn();
    await storeScene(accountId, { name: "Searchable counter" });
    const output = await executeTool(
      "search_store_scenes",
      { query: "searchable" },
      { accountId, db, emitScenes: () => undefined, prompt: "x" },
    );
    expect(output.startsWith('<untrusted_data source="store_search">')).toBe(true);
    expect(output).toContain("Searchable counter");
  });
});

// The agent proposes a frame install; the route streams the proposal and
// persists it on the reply, and nothing touches the frame.
describe("install proposals through the chat route", () => {
  async function activeFrame(accountId: string, name: string) {
    const [client] = await db
      .insert(linkedClients)
      .values({
        accountId,
        clientKind: "frame",
        publicDisplayName: name,
        tokenReference: `store-ai-frame-${userCounter}-${Date.now()}`,
      })
      .returning();
    const [frame] = await db
      .insert(frames)
      .values({
        accountId,
        linkedClientId: client!.id,
        name,
        publicKey: `store-ai-frame-key-${userCounter}-${Date.now()}`,
        status: "active",
      })
      .returning();
    return frame!;
  }

  it("streams the proposal, persists it, and assigns nothing", async () => {
    const { accountId } = await signIn();
    const frame = await activeFrame(accountId, "Hallway");
    const { scene } = await storeScene(accountId, { name: "Proposed counter" });
    scriptedCalls.push([
      { arguments: { frame_id: frame.id, scene_id: scene.id }, name: "add_scene_to_frame" },
    ]);

    const chatId = crypto.randomUUID();
    const { response, text } = await chat({ chatId, prompt: "put the counter on the hallway frame" });
    expect(response.status).toBe(200);
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const proposal = events.find((event) => event.type === "proposal");
    expect(proposal).toMatchObject({
      already_assigned: false,
      declared_settings_groups: [],
      frame: { id: frame.id, name: "Hallway" },
      kind: "install_scene",
      scene: { id: scene.id, name: "Proposed counter" },
    });
    expect(events.at(-1)?.type).toBe("done");

    // The model was told nothing was installed.
    const toolOutput = capturedInputs[1]?.find((item) => item.type === "function_call_output");
    expect(String(toolOutput?.output)).toContain("awaiting_approval");

    // Persisted with the reply, for the card to come back on reload.
    const [reply] = await db
      .select({ payload: aiChatMessages.payload, role: aiChatMessages.role })
      .from(aiChatMessages)
      .where(and(eq(aiChatMessages.chatId, chatId), eq(aiChatMessages.role, "assistant")));
    expect((reply?.payload as { proposals?: unknown[] })?.proposals).toHaveLength(1);

    // And the frame is untouched.
    const assignments = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.id));
    expect(assignments).toHaveLength(0);
  });
});

// What a request may put into the model context is bounded (a prompt, a
// scene) or cut (the history), and the daily cap counts what the account's
// other turns have reserved but not yet metered.
describe("context bounds and in-flight spend", () => {
  it("refuses an oversized prompt and an oversized scene", async () => {
    await signIn();
    const long = await chat({ prompt: "x".repeat(20_001) });
    expect(long.response.status).toBe(400);
    expect(JSON.parse(long.text)).toMatchObject({ error: "prompt_too_long" });

    const scene = renderScene("huge", "Huge", { text: "y".repeat(300_001) });
    const big = await chat({ prompt: "hello", scene, sceneId: "huge" });
    expect(big.response.status).toBe(400);
    expect(JSON.parse(big.text)).toMatchObject({ error: "scene_too_large" });
  });

  it("cuts an oversized history item before the model sees it", async () => {
    await signIn();
    const pasted = "p".repeat(maxHistoryItemChars + 500);
    const { response } = await chat({
      history: [{ content: pasted, role: "user" }, { content: "noted", role: "assistant" }],
      prompt: "and now?",
    });
    expect(response.status).toBe(200);
    const shown = JSON.stringify(capturedInputs[0]);
    expect(shown).toContain("…(truncated)");
    expect(shown).not.toContain(pasted);
  });

  it("counts other turns' reservations against the daily cap", async () => {
    const previousAccess = process.env.FRAMEOS_AI_SHARED_KEY_ACCESS;
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.FRAMEOS_AI_SHARED_KEY_ACCESS = "all";
    process.env.OPENAI_API_KEY = "sk-shared";
    try {
      const { accountId } = await signIn(false);
      // Two unfinished turns that between them have reserved the whole
      // $10 default cap: the ledger says nothing was spent, and the gate
      // must still refuse.
      reserveTurnSpend(accountId, "turn-a", 6_000_000n);
      reserveTurnSpend(accountId, "turn-b", 4_000_000n);
      const refused = await chat({ prompt: "hello" });
      expect(refused.response.status).toBe(402);
      expect(JSON.parse(refused.text)).toMatchObject({
        allowance: "shared",
        error: "daily_cap_reached",
        spent_micros: "10000000",
      });

      // Another account's reservations do not count.
      cookieJar.clear();
      const other = await signIn(false);
      const allowed = await chat({ prompt: "hello" });
      expect(allowed.response.status).toBe(200);
      await waitForPendingAiMetering();
      // ...and a finished turn has released its reservation.
      const again = await chat({ prompt: "hello again" });
      expect(again.response.status).toBe(200);
      expect(other.accountId).not.toBe(accountId);
    } finally {
      if (previousAccess === undefined) {
        delete process.env.FRAMEOS_AI_SHARED_KEY_ACCESS;
      } else {
        process.env.FRAMEOS_AI_SHARED_KEY_ACCESS = previousAccess;
      }
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });
});

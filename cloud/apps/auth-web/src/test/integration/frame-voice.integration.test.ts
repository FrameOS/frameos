// Voice chat for a cloud-managed frame, end to end (docs/voice-chat.md):
// enroll and confirm a real frame, assign it a scene, save the account's
// OpenAI key, then POST PCM chunks as the device with its enrollment bearer.
// The closing chunk is "transcribed" (a stubbed fetch to OpenAI's audio
// route) and answered by the agent loop (a scripted streamResponse), whose
// activate_scene lands on the frame's command queue the way the workspace's
// rail would. The model is handed ONLY the voice tools the owner's switches
// allow (docs/voice-chat.md "What the voice chat may do").
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  aiChatMessages,
  aiChats,
  createDb,
  frameCommands,
  photoShares,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseInputItem, ResponsesToolDefinition } from "../../lib/ai/openai";

const cookieJar = vi.hoisted(() => new Map<string, string>());
// What the scripted model does, round by round: text and function calls.
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

import { POST as mintClaimToken } from "../../../app/api/frames/claim-tokens/route";
import { POST as enrollFrame } from "../../../app/api/frames/enroll/route";
import { POST as confirmFrame } from "../../../app/api/frames/[frameId]/confirm/route";
import { GET as getFrame } from "../../../app/api/frames/[frameId]/route";
import { POST as postFolders } from "../../../app/api/photos/folders/route";
import { POST as setVoicePermissions } from "../../../app/api/frames/[frameId]/voice/permissions/route";
import { POST as assignFrameScenes } from "../../../app/api/frames/[frameId]/scenes/route";
import { POST as voiceRoute } from "../../../app/api/frames/[frameId]/voice/[sessionId]/route";
import { POST as saveAccountSettings } from "../../../app/api/settings/route";
import { TRANSCRIPTION_URL, voiceChatId } from "../../lib/ai/voice";
import { waitForPendingAiMetering } from "../../lib/billing";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;
const realFetch = globalThis.fetch;
// What the stubbed transcription "hears", and the audio it was handed.
const heard = { calls: [] as { prompt: string | null; wavBytes: number }[], text: "switch to the calendar please" };

afterAll(async () => {
  await waitForPendingAiMetering();
  vi.unstubAllGlobals();
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  script.requests.length = 0;
  script.rounds.length = 0;
  heard.calls.length = 0;
  heard.text = "switch to the calendar please";
  await waitForPendingAiMetering();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== TRANSCRIPTION_URL) {
      return realFetch(input, init);
    }
    const form = init?.body as FormData;
    const file = form.get("file") as Blob;
    heard.calls.push({ prompt: (form.get("prompt") as string | null) ?? null, wavBytes: file.size });
    return new Response(
      JSON.stringify({ text: heard.text, usage: { input_tokens: 120, output_tokens: 8, type: "tokens" } }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  });
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

async function signIn() {
  userCounter += 1;
  const providerSubject = `voice-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Voice User ${userCounter}`,
    email: `voice-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, { accountId, providerIssuer: issuer, providerSubject });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function devicePublicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

// A store scene whose scenes.json carries one runtime scene, `runtimeId`.
async function createStoreScene(accountId: string, name: string, runtimeId: string) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name,
      riskFlags: [],
      slug: `scene-${runtimeId}`,
      status: "active",
      visibility: "private",
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  const scenes = [{ edges: [], id: runtimeId, name, nodes: [] }];
  await db.insert(storeSceneVersions).values({
    content: Buffer.from(zipSync({ "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)) })),
    contentType: "application/zip",
    riskFlags: [],
    sceneId: scene.id,
    sha256: `test-${runtimeId}`,
    sizeBytes: 1000,
    version: 1,
  });
  return scene;
}

// Enroll → confirm → active: an ESP32 frame, the way a real one arrives.
async function activeFrame() {
  const accountId = await signIn();
  const mint = await mintClaimToken(postJson("/api/frames/claim-tokens", { name: "Kitchen" }, { origin: baseUrl }));
  expect(mint.status).toBe(200);
  const { claim_token } = (await mint.json()) as { claim_token: string };
  const enroll = await enrollFrame(
    postJson("/api/frames/enroll", {
      claim_token,
      frameos_version: "2026.10.20",
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

async function assignScenes(frameId: string, sceneIds: string[]) {
  const response = await assignFrameScenes(
    postJson(`/api/frames/${frameId}/scenes`, { scenes: sceneIds.map((scene_id) => ({ scene_id })) }, { origin: baseUrl }),
    routeParams(frameId),
  );
  expect(response.status).toBe(200);
}

async function saveOpenAiKey() {
  const response = await saveAccountSettings(
    postJson("/api/settings", { openAI: { backendApiKey: "sk-voice-test" } }, { origin: baseUrl }),
  );
  expect(response.status).toBe(200);
}

// A loud square wave: what a sentence looks like to the silence gate.
function speech(bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  for (let i = 0; i + 3 < bytes; i += 4) {
    out[i + 1] = 0x40;
    out[i + 3] = 0xc0;
  }
  return out;
}

function chunk(
  frameId: string,
  token: string,
  session: string,
  seq: number,
  done: boolean,
  bytes: number,
  body?: Uint8Array<ArrayBuffer>,
) {
  return voiceRoute(
    new NextRequest(new URL(`/api/frames/${frameId}/voice/${session}?seq=${seq}&done=${done ? 1 : 0}`, baseUrl), {
      body: body ?? speech(bytes),
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(bytes),
        "content-type": "audio/L16; rate=16000; channels=1",
      },
      method: "POST",
    }),
    { params: Promise.resolve({ frameId, sessionId: session }) },
  );
}

const SECOND = 32_000;

describe("POST /api/frames/{id}/voice/{session}", () => {
  it("streams chunks, transcribes the sentence and queues the spoken scene switch", async () => {
    const frame = await activeFrame();
    await saveOpenAiKey();
    const clock = await createStoreScene(frame.accountId, "Clock", "clock-rt");
    const calendar = await createStoreScene(frame.accountId, "Calendar", "calendar-rt");
    await assignScenes(frame.frame_id, [clock.id, calendar.id]);
    // The commands the assignment itself queued are not the voice chat's.
    await db.delete(frameCommands).where(eq(frameCommands.frameId, frame.frame_id));
    script.rounds.push(
      { calls: [{ arguments: {}, call_id: "c1", name: "list_scenes" }], text: "" },
      { calls: [{ arguments: { scene_id: calendar.id }, call_id: "c2", name: "activate_scene" }], text: "" },
      { calls: [], text: "Switched to Calendar." },
    );

    for (let seq = 0; seq < 2; seq += 1) {
      const response = await chunk(frame.frame_id, frame.access_token, "sess-0001", seq, false, SECOND);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ bytes: SECOND * (seq + 1), ok: true });
    }
    const response = await chunk(frame.frame_id, frame.access_token, "sess-0001", 2, true, 8000);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      reply: "Switched to Calendar.",
      tools: ["list_scenes", "activate_scene"],
      transcript: "switch to the calendar please",
    });

    // All the audio, as one WAV, with the scene names as the hint.
    expect(heard.calls).toEqual([{ prompt: "Clock, Calendar", wavBytes: 44 + 2 * SECOND + 8000 }]);

    // The model saw the voice prompt, the frame's context, and ONLY the
    // voice tools the owner's switches allow: a frame's token must not drive
    // the account's tools, and new scenes on the frame (show_image) are off
    // until the owner opts in.
    const first = script.requests[0]!;
    expect(first.instructions).toContain("You are the FrameOS voice assistant for one smart frame.");
    expect(first.tools.map((tool) => tool.name)).toEqual([
      "list_scenes",
      "activate_scene",
      "set_scene_state",
      "render_now",
      "rotate_frame",
      "list_albums",
      "show_album",
    ]);
    const context = (first.input[0]!.content as { text: string }[])[0]!.text;
    // No service-setting group granted to this frame's scenes: no picture source.
    expect(context).toContain("- Picture sources for show_image: none");
    expect(context).toContain("- Voice chat may: change the frame's settings (rotate_frame); use the installed scenes");
    expect(context).toContain("- Voice chat may not: put new scenes on the frame (show_image)");
    expect(context).toContain(`Calendar (${calendar.id})`);
    expect(context).toContain("spoke this into the frame's microphone");
    const outputs = Object.fromEntries(
      script.requests[2]!.input
        .filter((item) => item.type === "function_call_output")
        .map((item) => [item.call_id, item.output as string]),
    );
    expect(outputs.c1).toContain('"Calendar"');
    expect(JSON.parse(outputs.c2 as string)).toMatchObject({ ok: true, scene: "Calendar", type: "set_scenes" });

    // The device never acked the assignment, so the switch is the assigned
    // set re-pushed with Calendar active: the event route's rule.
    const commands = await db.select().from(frameCommands).where(eq(frameCommands.frameId, frame.frame_id));
    expect(commands.map((command) => command.type)).toEqual(["set_scenes"]);
    expect((commands[0]!.payload as { scene_id: string }).scene_id).toBe("calendar-rt");

    // The exchange is the frame's voice chat: one per frame, under the frame.
    const chats = await db.select().from(aiChats).where(eq(aiChats.accountId, frame.accountId));
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ frameId: frame.frame_id, id: voiceChatId(frame.frame_id) });
    const messages = await db.select().from(aiChatMessages).where(eq(aiChatMessages.chatId, chats[0]!.id));
    expect(messages.map((message) => [message.role, message.content, message.tool])).toEqual([
      ["user", "switch to the calendar please", "voice"],
      ["assistant", "Switched to Calendar.", "voice"],
    ]);

    // A second sentence has the first as history.
    script.rounds.length = 0;
    script.rounds.push({ calls: [], text: "Back on the Clock." });
    heard.text = "and back";
    const again = await chunk(frame.frame_id, frame.access_token, "sess-0002", 0, true, SECOND);
    expect(again.status).toBe(200);
    const texts = script.requests[3]!.input
      .filter((item) => Array.isArray(item.content))
      .map((item) => (item.content as { text: string }[])[0]!.text);
    expect(texts.slice(1)).toEqual(["switch to the calendar please", "Switched to Calendar.", "and back"]);
  });

  it("offers the model only what the owner's switches allow, and refuses the rest", async () => {
    const frame = await activeFrame();
    await saveOpenAiKey();
    const clock = await createStoreScene(frame.accountId, "Clock", "clock-rt");
    await assignScenes(frame.frame_id, [clock.id]);
    await db.delete(frameCommands).where(eq(frameCommands.frameId, frame.frame_id));

    // The owner turns the installed scenes off and new scenes on; the frame
    // reports the whole set, defaults filled in.
    const set = await setVoicePermissions(
      postJson(`/api/frames/${frame.frame_id}/voice/permissions`, { create_scenes: true, use_scenes: false }, { origin: baseUrl }),
      routeParams(frame.frame_id),
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      status: "updated",
      voice_permissions: { change_settings: true, create_scenes: true, use_albums: true, use_scenes: false },
    });
    const shown = await getFrame(new NextRequest(new URL(`/api/frames/${frame.frame_id}`, baseUrl)), routeParams(frame.frame_id));
    expect(((await shown.json()) as { frame: { voice_permissions: unknown } }).frame.voice_permissions).toEqual({
      change_settings: true,
      create_scenes: true,
      use_albums: true,
      use_scenes: false,
    });

    // The model names a switched-off tool anyway: refused, nothing queued.
    script.rounds.push(
      { calls: [{ arguments: { scene_id: clock.id }, call_id: "c1", name: "activate_scene" }], text: "" },
      { calls: [], text: "Switching scenes is switched off for this frame." },
    );
    const response = await chunk(frame.frame_id, frame.access_token, "sess-0010", 0, true, SECOND);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tools: ["activate_scene"] });
    const first = script.requests[0]!;
    expect(first.tools.map((tool) => tool.name)).toEqual([
      "list_scenes",
      "show_image",
      "rotate_frame",
      "list_albums",
      "show_album",
    ]);
    const context = (first.input[0]!.content as { text: string }[])[0]!.text;
    expect(context).toContain("- Voice chat may: change the frame's settings (rotate_frame); put new scenes on the frame (show_image)");
    expect(context).toContain("- Voice chat may not: use the installed scenes");
    const output = script.requests[1]!.input.find((item) => item.type === "function_call_output");
    expect(JSON.parse((output as { output: string }).output)).toMatchObject({ error: "not_allowed", ok: false });
    expect(await db.select().from(frameCommands).where(eq(frameCommands.frameId, frame.frame_id))).toEqual([]);

    // The switches are the owner's: no session, no change.
    cookieJar.clear();
    const anonymous = await setVoicePermissions(
      postJson(`/api/frames/${frame.frame_id}/voice/permissions`, { use_scenes: true }, { origin: baseUrl }),
      routeParams(frame.frame_id),
    );
    expect(anonymous.status).toBe(401);
  });

  it("lists the albums and plays one: the frame's share link, a private scene, the push with it active", async () => {
    const frame = await activeFrame();
    await saveOpenAiKey();
    const clock = await createStoreScene(frame.accountId, "Clock", "clock-rt");
    await assignScenes(frame.frame_id, [clock.id]);
    for (const path of ["Summer 2026", "Winter"]) {
      expect((await postFolders(postJson("/api/photos/folders", { path }, { origin: baseUrl }))).status).toBe(200);
    }
    await db.delete(frameCommands).where(eq(frameCommands.frameId, frame.frame_id));
    script.rounds.push(
      { calls: [{ arguments: {}, call_id: "c1", name: "list_albums" }], text: "" },
      { calls: [{ arguments: { path: "Summer 2026", seconds: 600 }, call_id: "c2", name: "show_album" }], text: "" },
      { calls: [], text: "Playing Summer 2026." },
    );
    heard.text = "show the summer photos";
    const response = await chunk(frame.frame_id, frame.access_token, "sess-0011", 0, true, SECOND);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tools: ["list_albums", "show_album"] });
    const outputs = Object.fromEntries(
      script.requests[2]!.input
        .filter((item) => item.type === "function_call_output")
        .map((item) => [item.call_id, item.output as string]),
    );
    expect(outputs.c1).toContain('<untrusted_data source="photo_albums">');
    expect(outputs.c1).toContain('"path":"Summer 2026"');
    expect(outputs.c1).toContain('"path":"Winter"');
    const shown = JSON.parse(outputs.c2 as string) as { ok: boolean; scene: string; scene_id: string; album: string; type: string };
    expect(shown).toMatchObject({ album: "Summer 2026", ok: true, scene: "Summer 2026", type: "set_scenes" });

    // A private scene of the account playing the frame's own link to the folder...
    const [saved] = await db.select().from(storeScenes).where(eq(storeScenes.id, shown.scene_id));
    expect(saved).toMatchObject({ accountId: frame.accountId, name: "Summer 2026", visibility: "private" });
    const shares = await db.select().from(photoShares).where(eq(photoShares.accountId, frame.accountId));
    expect(shares.map((share) => [share.path, share.frameId])).toEqual([["Summer 2026", frame.frame_id]]);
    // ...assigned next to the Clock and pushed with it active, at the spoken interval.
    const commands = await db.select().from(frameCommands).where(eq(frameCommands.frameId, frame.frame_id));
    expect(commands.map((command) => command.type)).toEqual(["set_scenes"]);
    const payload = commands[0]!.payload as { scene_id: string; scenes: { name: string; id: string; settings: { refreshInterval: number }; nodes: { data: { keyword: string; config?: { album?: string } } }[] }[] };
    expect(payload.scenes.map((scene) => scene.name)).toEqual(["Clock", "Summer 2026"]);
    const album = payload.scenes[1]!;
    expect(payload.scene_id).toBe(album.id);
    expect(album.settings.refreshInterval).toBe(600);
    const app = album.nodes.find((node) => node.data.keyword === "photoAlbum");
    expect(app?.data.config?.album).toContain(`/api/photos/shared/${shares[0]!.token}`);

    // An album that is not there: told, nothing installed. The script is
    // indexed by the request count across turns, so the second turn's rounds
    // sit after the first's three.
    const pad = { calls: [], text: "" };
    script.rounds.length = 0;
    script.rounds.push(
      pad,
      pad,
      pad,
      { calls: [{ arguments: { path: "Nope" }, call_id: "c1", name: "show_album" }], text: "" },
      { calls: [], text: "There is no album called Nope." },
    );
    const missing = await chunk(frame.frame_id, frame.access_token, "sess-0012", 0, true, SECOND);
    expect(missing.status).toBe(200);
    const refused = script.requests[4]!.input.find((item) => item.type === "function_call_output");
    expect(JSON.parse((refused as { output: string }).output)).toMatchObject({ error: "album_unavailable", ok: false });
    expect(await db.select().from(frameCommands).where(eq(frameCommands.frameId, frame.frame_id))).toHaveLength(1);
  });

  it("refuses another frame's token, a gap in the chunks and an oversized chunk", async () => {
    const frame = await activeFrame();
    const other = await activeFrame();
    expect((await chunk(frame.frame_id, other.access_token, "sess-0003", 0, false, SECOND)).status).toBe(403);
    expect((await chunk(frame.frame_id, frame.access_token, "sess-0003", 0, false, SECOND)).status).toBe(202);
    const gap = await chunk(frame.frame_id, frame.access_token, "sess-0003", 2, false, SECOND);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ error: "seq_mismatch" });
    const late = await chunk(frame.frame_id, frame.access_token, "sess-0003", 1, false, SECOND);
    expect(await late.json()).toMatchObject({ error: "unknown_session" });
    expect((await chunk(frame.frame_id, frame.access_token, "sess-0004", 0, false, 64 * 1024 + 1)).status).toBe(413);
    expect((await chunk(frame.frame_id, frame.access_token, "bad id!", 0, false, SECOND)).status).toBe(400);
    expect(heard.calls).toEqual([]);
  });

  it("tells the frame when the account has no AI, or nothing was heard", async () => {
    const frame = await activeFrame();
    const noKey = await chunk(frame.frame_id, frame.access_token, "sess-0005", 0, true, SECOND);
    expect(noKey.status).toBe(200);
    expect(await noKey.json()).toMatchObject({ error: "ai_unavailable", ok: false });
    expect(heard.calls).toEqual([]);

    await saveOpenAiKey();
    const tooShort = await chunk(frame.frame_id, frame.access_token, "sess-0006", 0, true, 2000);
    expect(await tooShort.json()).toMatchObject({ error: "nothing_heard", ok: false });
    expect(heard.calls).toEqual([]);

    heard.text = "   ";
    const blank = await chunk(frame.frame_id, frame.access_token, "sess-0007", 0, true, SECOND);
    expect(await blank.json()).toMatchObject({ error: "nothing_heard", ok: false });
    expect(script.requests).toEqual([]);

    // Silence never reaches OpenAI: a transcription of nothing comes back as
    // the prompt (the scene names), so the level is checked first.
    const before = heard.calls.length;
    const silence = await chunk(frame.frame_id, frame.access_token, "sess-0008", 0, true, SECOND, new Uint8Array(SECOND));
    const silenceBody = (await silence.json()) as { ok: boolean; error: string; detail: string };
    expect(silenceBody).toMatchObject({ error: "nothing_heard", ok: false });
    expect(silenceBody.detail).toMatch(/^silence/);
    expect(heard.calls.length).toBe(before);

    // And a transcript that IS the prompt is noise that got through the gate.
    const clock = await createStoreScene(frame.accountId, "Clock", "clock-rt");
    const calendar = await createStoreScene(frame.accountId, "Calendar", "calendar-rt");
    await assignScenes(frame.frame_id, [clock.id, calendar.id]);
    heard.text = "Clock, Calendar.";
    const echo = await chunk(frame.frame_id, frame.access_token, "sess-0009", 0, true, SECOND);
    expect(await echo.json()).toEqual({ detail: "only the scene names came back", error: "nothing_heard", ok: false });
    expect(script.requests).toEqual([]);
  });
});

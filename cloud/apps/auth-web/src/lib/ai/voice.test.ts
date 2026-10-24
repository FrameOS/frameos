// The voice chat's pure parts (docs/voice-chat.md): the session store's caps,
// the WAV wrapper, the frame-scoped tools, and the parity of prompt and tool
// definitions with the backend's copy (backend/app/utils/voice_chat.py).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildVoiceSystemPrompt,
  imageSourcesForSettings,
  pcmToWav,
  VOICE_MAX_AUDIO_BYTES,
  voiceChatId,
  voiceSessions,
  VoiceSessionStore,
  voiceToolDefinitions,
  voiceTools,
} from "./voice";

describe("the voice session store", () => {
  it("collects chunks in order and caps a session at 30 s", () => {
    const clock = { now: 100_000 };
    const store = new VoiceSessionStore(60_000, () => clock.now);
    const first = store.append("f1", "s1", 0, new Uint8Array([1, 2]));
    expect(typeof first).not.toBe("string");
    expect(store.append("f1", "s1", 1, new Uint8Array([3, 4]))).toMatchObject({ received: 4 });
    // Another frame's session with the same id is another session.
    expect(store.append("f2", "s1", 0, new Uint8Array([9]))).toMatchObject({ frameId: "f2", received: 1 });
    expect(store.take("f1", "s1")).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(store.take("f1", "s1")).toBeUndefined();
    // Over the cap the session is dropped.
    store.append("f1", "s2", 0, new Uint8Array(10));
    expect(store.append("f1", "s2", 1, new Uint8Array(VOICE_MAX_AUDIO_BYTES))).toBe("session_too_long");
    expect(store.take("f1", "s2")).toBeUndefined();
    // A session nobody wrote to for the TTL is forgotten.
    clock.now += 61_000;
    expect(store.append("f2", "s1", 1, new Uint8Array([1]))).toBe("unknown_session");
    expect(store.size).toBe(0);
  });

  it("refuses a gap or a repeat and forgets the session", () => {
    const store = new VoiceSessionStore();
    store.append("f", "s", 0, new Uint8Array(1));
    expect(store.append("f", "s", 2, new Uint8Array(1))).toBe("seq_mismatch");
    expect(store.append("f", "s", 1, new Uint8Array(1))).toBe("unknown_session");
    // An empty closing chunk is fine: the release came with nothing new.
    store.append("f", "t", 0, new Uint8Array(2));
    expect(store.append("f", "t", 1, new Uint8Array(0))).toMatchObject({ nextSeq: 2, received: 2 });
  });

  it("has one process-wide store", () => {
    expect(voiceSessions).toBeInstanceOf(VoiceSessionStore);
  });
});

describe("pcmToWav", () => {
  it("writes a 16 kHz 16-bit mono header", () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4]);
  });
});

describe("voiceTools", () => {
  const scenes = [
    { default: true, id: "11111111-1111-4111-8111-111111111111", name: "Clock" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Calendar" },
  ];

  it("lists the frame's scenes, marks the showing one, and switches by id", async () => {
    const queued: unknown[] = [];
    const tools = voiceTools({
      activeSceneId: scenes[1]!.id,
      queue: async (type, payload) => {
        queued.push([type, payload]);
        return { command_id: "cmd-1", ok: true };
      },
      scenes,
    });
    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      "list_scenes",
      "activate_scene",
      "set_scene_state",
      "render_now",
      "show_image",
      "rotate_frame",
    ]);
    const listing = await tools.call("list_scenes", {});
    expect(listing.text.startsWith('<untrusted_data source="frame_scenes">')).toBe(true);
    expect(listing.text).toContain('"showing":true');
    const switched = await tools.call("activate_scene", { scene_id: scenes[0]!.id });
    expect(JSON.parse(switched.text)).toEqual({ command_id: "cmd-1", ok: true, scene: "Clock" });
    expect(queued).toEqual([["set_current_scene", { scene_id: scenes[0]!.id }]]);
    expect(tools.changed).toEqual(["activate_scene"]);
  });

  it("refuses an unknown scene and a bad state without queuing", async () => {
    const queued: unknown[] = [];
    const tools = voiceTools({
      activeSceneId: null,
      queue: async (type) => {
        queued.push(type);
        return { ok: true };
      },
      scenes,
    });
    expect(JSON.parse((await tools.call("activate_scene", { scene_id: "nope" })).text)).toEqual({
      error: "unknown_scene",
      ok: false,
      scenes: scenes.map((scene) => scene.id),
    });
    expect(JSON.parse((await tools.call("set_scene_state", { state: [] })).text).ok).toBe(false);
    expect(JSON.parse((await tools.call("set_scene_state", { state: {} })).text).ok).toBe(false);
    expect(queued).toEqual([]);
    await tools.call("set_scene_state", { state: { text: "buy milk" } });
    await tools.call("render_now", {});
    expect(queued).toEqual(["scene_event", "render"]);
    // No picture source and no settings hook: the model is told, nothing moves.
    expect(JSON.parse((await tools.call("show_image", { query: "a banana" })).text).error).toBe("no_image_source");
    expect(JSON.parse((await tools.call("rotate_frame", { degrees: 90 })).text).ok).toBe(false);
    expect(queued).toEqual(["scene_event", "render"]);
  });

  it("previews a picture scene from the sources the frame's keys allow", async () => {
    const previews: unknown[] = [];
    const tools = voiceTools({
      activeSceneId: null,
      imageSources: ["photo"],
      previewScenes: async (previewed, sceneId) => {
        previews.push([previewed, sceneId]);
        return { command_id: "cmd-2", ok: true, type: "set_scenes" };
      },
      queue: async () => ({ ok: true }),
      scenes,
    });
    const shown = JSON.parse((await tools.call("show_image", { query: "a banana" })).text);
    expect(shown).toMatchObject({ command_id: "cmd-2", ok: true, scene: "Voice: a banana", source: "photo" });
    const [[previewed, sceneId]] = previews as [[Record<string, unknown>[], string]];
    expect(previewed).toHaveLength(1);
    const scene = previewed[0]!;
    expect(scene.id).toBe(sceneId);
    const nodes = scene.nodes as { data: { keyword: string; config?: Record<string, unknown> } }[];
    expect(nodes.find((node) => node.data.keyword === "unsplash")?.data.config).toEqual({ search: "a banana" });
    expect((scene.apps as Record<string, { origin: string; sources: Record<string, string> }>).unsplash?.origin).toBe(
      "repo/apps/image/unsplash",
    );
    expect((scene.settings as { refreshInterval: number }).refreshInterval).toBe(3600);
    // Art was asked for and only photos are allowed: told which sources exist.
    expect(JSON.parse((await tools.call("show_image", { query: "a cat", source: "generated" })).text)).toEqual({
      available: ["photo"],
      error: "source_unavailable",
      ok: false,
    });
    expect(previews).toHaveLength(1);
    expect(tools.changed).toEqual(["show_image"]);
  });

  it("rotates the frame within the contract's rule and knows no interval", async () => {
    const pushed: unknown[] = [];
    const tools = voiceTools({
      activeSceneId: null,
      queue: async () => ({ ok: true }),
      scenes,
      updateSettings: async (settings) => {
        pushed.push(settings);
        return { command_id: "cmd-3", ok: true, type: "set_settings" };
      },
    });
    expect(JSON.parse((await tools.call("rotate_frame", { degrees: 90 })).text)).toEqual({
      command_id: "cmd-3",
      ok: true,
      restart: true,
      settings: { rotate: 90 },
      type: "set_settings",
    });
    expect(JSON.parse((await tools.call("rotate_frame", { degrees: 45 })).text)).toEqual({
      error: "degrees must be 0, 90, 180 or 270",
      ok: false,
    });
    expect(JSON.parse((await tools.call("rotate_frame", {})).text).ok).toBe(false);
    // The frame's render interval is not a voice setting at all.
    expect(JSON.parse((await tools.call("set_frame_settings", { interval: 600 })).text).ok).toBe(false);
    expect(pushed).toEqual([{ rotate: 90 }]);
  });
});

describe("imageSourcesForSettings", () => {
  it("names the sources whose keys the frame receives, photo first", () => {
    expect(imageSourcesForSettings({})).toEqual([]);
    expect(imageSourcesForSettings({ openAI: { apiKey: "sk" }, unsplash: { accessKey: "u" } })).toEqual([
      "photo",
      "generated",
    ]);
    expect(imageSourcesForSettings({ openAI: { apiKey: "sk" }, unsplash: { accessKey: " " } })).toEqual(["generated"]);
  });
});

describe("the silence gate", () => {
  it("measures the loudest sample and spots a transcript that is only the hint", async () => {
    const { pcmPeak, transcriptIsHintEcho, VOICE_SILENCE_PEAK } = await import("./voice");
    expect(pcmPeak(new Uint8Array(64))).toBe(0);
    expect(pcmPeak(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x01]))).toBe(16384);
    expect(pcmPeak(new Uint8Array([0xff, 0x7f]))).toBe(32767);
    expect(VOICE_SILENCE_PEAK).toBeGreaterThan(0);
    expect(transcriptIsHintEcho("Clock, Calendar.", ["Clock", "Calendar"])).toBe(true);
    expect(transcriptIsHintEcho("clock calendar", ["Clock", "Calendar"])).toBe(true);
    expect(transcriptIsHintEcho("switch to the calendar", ["Clock", "Calendar"])).toBe(false);
    expect(transcriptIsHintEcho("Clock", ["Clock", "Calendar"])).toBe(false);
    expect(transcriptIsHintEcho("anything", [])).toBe(false);
  });
});

describe("voiceChatId", () => {
  it("is a stable uuid per frame", () => {
    const id = voiceChatId("frame-a");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(voiceChatId("frame-a")).toBe(id);
    expect(voiceChatId("frame-b")).not.toBe(id);
  });
});

describe("parity with the backend", () => {
  const python = readFileSync(
    fileURLToPath(new URL("../../../../../../backend/app/utils/voice_chat.py", import.meta.url)),
    "utf8",
  );

  it("shares the system prompt line for line", () => {
    for (const line of buildVoiceSystemPrompt().split("\n")) {
      expect(python).toContain(line);
    }
  });

  it("shares the tool names and descriptions", () => {
    for (const tool of voiceToolDefinitions) {
      expect(python).toContain(`"name": "${tool.name}"`);
      const description = tool.description.split(". ")[0] ?? tool.description;
      expect(python).toContain(description.slice(0, 40));
    }
  });
});

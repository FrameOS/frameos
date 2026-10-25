// The voice chat's pure parts (docs/voice-chat.md): the session store's caps,
// the WAV wrapper, the frame-scoped tools and the owner's switches over them,
// and the parity of prompt, tool definitions and permission table with the
// backend's copy (backend/app/utils/voice_chat.py).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildVoiceSystemPrompt,
  defaultVoicePermissions,
  imageSourcesForSettings,
  pcmToWav,
  readVoicePermissions,
  VOICE_MAX_AUDIO_BYTES,
  voiceChatId,
  voiceContextBlock,
  voiceSessions,
  VoiceSessionStore,
  voiceToolDefinitions,
  voiceToolPermissions,
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
    // The defaults: everything but putting new scenes on the frame, which the
    // owner opts into (docs/voice-chat.md "What the voice chat may do").
    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      "list_scenes",
      "activate_scene",
      "set_scene_state",
      "render_now",
      "rotate_frame",
      "list_albums",
      "show_album",
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
      permissions: { ...defaultVoicePermissions, create_scenes: true },
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
      permissions: { ...defaultVoicePermissions, create_scenes: true },
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

  it("offers only what the owner's switches allow, and refuses the rest when named anyway", async () => {
    const queued: unknown[] = [];
    const tools = voiceTools({
      activeSceneId: null,
      imageSources: ["photo"],
      permissions: { change_settings: false, create_scenes: true, use_albums: false, use_scenes: false },
      previewScenes: async () => ({ command_id: "cmd-4", ok: true, type: "set_scenes" }),
      queue: async (type) => {
        queued.push(type);
        return { ok: true };
      },
      scenes,
      updateSettings: async () => ({ ok: true }),
    });
    // The listing is always there: a read, and what the model names when it declines.
    expect(tools.definitions.map((tool) => tool.name)).toEqual(["list_scenes", "show_image"]);
    for (const [name, args] of [
      ["activate_scene", { scene_id: scenes[0]!.id }],
      ["set_scene_state", { state: { text: "hi" } }],
      ["render_now", {}],
      ["rotate_frame", { degrees: 90 }],
      ["list_albums", {}],
      ["show_album", { path: "Summer" }],
    ] as const) {
      const refused = JSON.parse((await tools.call(name, args as never)).text);
      expect(refused, name).toMatchObject({ error: "not_allowed", ok: false });
      expect(refused.detail, name).toContain("The owner has not allowed the voice chat to");
    }
    expect(queued).toEqual([]);
    expect(tools.changed).toEqual([]);
    expect(JSON.parse((await tools.call("show_image", { query: "a banana" })).text).ok).toBe(true);
    expect((await tools.call("list_scenes", {})).text).toContain('"Clock"');

    // Everything off leaves the listing, and the context says so in two lines.
    const none = { change_settings: false, create_scenes: false, use_albums: false, use_scenes: false };
    expect(voiceTools({ activeSceneId: null, permissions: none, queue: async () => ({ ok: true }), scenes }).definitions.map((tool) => tool.name)).toEqual(["list_scenes"]);
    const context = voiceContextBlock("frame", null, 0, [], none);
    expect(context).toContain("- Voice chat may: nothing but list the scenes");
    expect(context).toContain(
      "- Voice chat may not: change the frame's settings (rotate_frame); use the installed scenes: switch between " +
        "them, set their fields, redraw (activate_scene, set_scene_state, render_now); put new scenes on the frame (show_image); " +
        "play the photo albums: list them, show one on the frame (list_albums, show_album)",
    );
    const defaults = voiceContextBlock("frame", null, 0, []);
    expect(defaults).toContain("- Voice chat may: change the frame's settings (rotate_frame); use the installed scenes");
    expect(defaults).toContain("- Voice chat may not: put new scenes on the frame (show_image)");
  });

  it("lists the albums and plays one through the route's own photo library", async () => {
    const installs: unknown[] = [];
    const tools = voiceTools({
      activeSceneId: null,
      albums: {
        install: async (path, options) => {
          installs.push([path, options]);
          return { album: path, command_id: "cmd-5", ok: true, scene: path, scene_id: "s-1", type: "set_scenes" };
        },
        list: async () => ({ albums: [{ name: "Summer 2026", path: "Summer 2026", photos: 12 }] }),
      },
      queue: async () => ({ ok: true }),
      scenes,
    });
    const listed = await tools.call("list_albums", {});
    expect(listed.text.startsWith('<untrusted_data source="photo_albums">')).toBe(true);
    expect(listed.text).toContain('"path":"Summer 2026"');
    const shown = JSON.parse((await tools.call("show_album", { path: "/Summer 2026/", seconds: 600 })).text);
    expect(shown).toMatchObject({ album: "Summer 2026", ok: true, scene: "Summer 2026", type: "set_scenes" });
    expect(installs).toEqual([["Summer 2026", { seconds: 600 }]]);
    expect(tools.changed).toEqual(["show_album"]);
    // A bad interval or order never reaches the library; no path neither.
    expect(JSON.parse((await tools.call("show_album", { path: "Summer 2026", seconds: 0 })).text).ok).toBe(false);
    expect(JSON.parse((await tools.call("show_album", { order: "sideways", path: "Summer 2026" })).text).ok).toBe(false);
    expect(JSON.parse((await tools.call("show_album", {})).text).ok).toBe(false);
    expect(installs).toHaveLength(1);
    // Without a library hook (a test's bare tools) the model is told, not thrown at.
    const bare = voiceTools({ activeSceneId: null, queue: async () => ({ ok: true }), scenes });
    expect(JSON.parse((await bare.call("list_albums", {})).text).error).toBe("photos_unavailable");
  });

  it("reads the stored column with the defaults for what is missing or malformed", () => {
    expect(readVoicePermissions(null)).toEqual({
      change_settings: true,
      create_scenes: false,
      use_albums: true,
      use_scenes: true,
    });
    expect(readVoicePermissions({ create_scenes: true, use_scenes: "no" })).toEqual({
      change_settings: true,
      create_scenes: true,
      use_albums: true,
      use_scenes: true,
    });
    // Every tool but the listing answers to a switch, and the table names real tools.
    expect(new Set(Object.keys(voiceToolPermissions))).toEqual(
      new Set(voiceToolDefinitions.map((tool) => tool.name).filter((name) => name !== "list_scenes")),
    );
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

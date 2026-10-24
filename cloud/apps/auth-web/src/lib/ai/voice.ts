// Voice chat for cloud-managed ESP32 frames (docs/voice-chat.md): the frame
// streams what its user says while they hold LEFT+RIGHT, this transcribes it
// and runs one turn of the AI chat about that frame with a small
// frame-scoped toolset.
//
// Three parts, each small:
// - the session store: raw PCM chunks a frame POSTs while it records, kept
//   in this process's memory (like the AI turns, turn-runner.ts) until the
//   chunk with `done=1` arrives; 30 s of audio at most per session;
// - the transcription: OpenAI's /v1/audio/transcriptions on the PCM wrapped
//   as a WAV, the frame's scene names as the prompt;
// - the turn: the chat's own agent loop (loop.ts) with the voice system
//   prompt, the frame's context block and voiceTools — the six tools a
//   frame's own token may drive (list scenes, activate one, set the showing
//   scene's state, redraw, show a picture as a preview scene from the keys
//   the frame already has, rotate / re-time the frame). Not the MCP server's
//   tools: a frame's credential is not the owner's.
//
// The backend's copy is backend/app/utils/voice_chat.py: the prompt and the
// tool definitions are kept the same there (its test reads this file).
import { createHash, randomUUID } from "node:crypto";
import { appCatalog } from "./context";
import type { ResponsesToolDefinition } from "./openai";
import { OpenAiRequestError } from "./openai";
import type { JsonObject } from "./scene-utils";
import type { ExtraTools, ToolOutput } from "./tools";
import { untrustedResult } from "./tools";

export const VOICE_SAMPLE_RATE_HZ = 16000;
export const VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE_HZ * 2;
// The frame records 30 s at most (FOS_VOICE_MAX_SECONDS); the caps here
// mirror it so a leaked token cannot fill the process with audio.
export const VOICE_MAX_AUDIO_BYTES = 30 * VOICE_BYTES_PER_SECOND;
export const VOICE_MAX_CHUNK_BYTES = 64 * 1024;
export const VOICE_SESSION_TTL_MS = 60 * 1000;
export const VOICE_SESSIONS_PER_FRAME_PER_15_MIN = 20;
// Under this much audio nobody said anything a transcription could hear.
export const VOICE_MIN_AUDIO_BYTES = Math.round(0.3 * VOICE_BYTES_PER_SECOND);
export const VOICE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
// The model that hears: OpenAI's small transcription model, priced per audio
// token (pricing.ts), fine on a sentence.
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
export const MAX_TRANSCRIPT_CHARS = 4000;
export const MAX_VOICE_ROUNDS = 6;
export const MAX_VOICE_HISTORY = 8;

// ------------------------------------------------------------- sessions

export type VoiceSession = {
  frameId: string;
  sessionId: string;
  chunks: Uint8Array[];
  nextSeq: number;
  received: number;
  updatedAt: number;
};

export type VoiceAppendError = "seq_mismatch" | "session_too_long" | "unknown_session";

// The audio of sessions still being spoken, per (frame, session id).
export class VoiceSessionStore {
  private readonly sessions = new Map<string, VoiceSession>();
  constructor(
    private readonly ttlMs = VOICE_SESSION_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private sweep() {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  /** Add one chunk; the session, or why not: `seq_mismatch` (a gap or a
   * repeat; the frame gives the session up), `session_too_long` (past the
   * 30 s cap), `unknown_session` (a seq > 0 for a session this process never
   * saw: a restart, or a wait longer than the TTL). */
  append(frameId: string, sessionId: string, seq: number, data: Uint8Array): VoiceSession | VoiceAppendError {
    this.sweep();
    const key = `${frameId}:${sessionId}`;
    let session = this.sessions.get(key);
    if (!session) {
      if (seq !== 0) {
        return "unknown_session";
      }
      session = { chunks: [], frameId, nextSeq: 0, received: 0, sessionId, updatedAt: this.now() };
      this.sessions.set(key, session);
    }
    if (seq !== session.nextSeq) {
      this.sessions.delete(key);
      return "seq_mismatch";
    }
    if (session.received + data.length > VOICE_MAX_AUDIO_BYTES) {
      this.sessions.delete(key);
      return "session_too_long";
    }
    if (data.length > 0) {
      session.chunks.push(data);
      session.received += data.length;
    }
    session.nextSeq += 1;
    session.updatedAt = this.now();
    return session;
  }

  /** The finished session's audio, removed from the store: the audio is kept
   * nowhere once the turn is over. */
  take(frameId: string, sessionId: string): Uint8Array | undefined {
    const key = `${frameId}:${sessionId}`;
    const session = this.sessions.get(key);
    if (!session) {
      return undefined;
    }
    this.sessions.delete(key);
    const out = new Uint8Array(session.received);
    let offset = 0;
    for (const chunk of session.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  get size() {
    return this.sessions.size;
  }
}

// One store for the process; tests make their own.
export const voiceSessions = new VoiceSessionStore();

// ---------------------------------------------------------- transcription

// Below this peak (of 32767) nobody spoke: the bench E1002's MEMS microphone
// reads speech at arm's length in the thousands and a quiet room in the
// tens. A transcription of silence is not empty: the model echoes its prompt
// (the scene names, 2026-10-24 bench), so the gate sits before the call.
export const VOICE_SILENCE_PEAK = 250;

/** The loudest sample's magnitude, 0..32768. */
export function pcmPeak(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  let peak = 0;
  for (let offset = 0; offset < view.byteLength; offset += 2) {
    const sample = Math.abs(view.getInt16(offset, true));
    if (sample > peak) {
      peak = sample;
    }
  }
  return peak;
}

function normalizedWords(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

/** The transcription came back as the prompt it was given (the scene names,
 * joined), which is what the model does with silence or noise. */
export function transcriptIsHintEcho(transcript: string, sceneNames: string[]): boolean {
  if (sceneNames.length === 0) {
    return false;
  }
  return normalizedWords(transcript) === normalizedWords(sceneNames.join(", "));
}

/** A 16-bit mono WAV around the frame's raw little-endian PCM. */
export function pcmToWav(pcm: Uint8Array, sampleRate = VOICE_SAMPLE_RATE_HZ): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export type TranscriptionUsage = { inputTokens: number; outputTokens: number };

/** What was said, as text, and what OpenAI charged for hearing it. Throws
 * OpenAiRequestError on a refused call. */
export async function transcribePcm(
  pcm: Uint8Array,
  {
    apiKey,
    prompt,
    fetchImpl = fetch,
  }: { apiKey: string; prompt?: string | undefined; fetchImpl?: typeof fetch },
): Promise<{ text: string; usage: TranscriptionUsage | null }> {
  const form = new FormData();
  form.set("model", TRANSCRIPTION_MODEL);
  form.set("response_format", "json");
  if (prompt) {
    form.set("prompt", prompt.slice(0, 1000));
  }
  const wav = pcmToWav(pcm);
  form.set(
    "file",
    new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], {
      type: "audio/wav",
    }),
    "speech.wav",
  );
  const response = await fetchImpl(TRANSCRIPTION_URL, {
    body: form,
    headers: { authorization: `Bearer ${apiKey}` },
    method: "POST",
  });
  if (!response.ok) {
    let detail = (await response.text()).slice(0, 300);
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      detail = parsed.error?.message ?? detail;
    } catch {
      // the body is whatever came back
    }
    throw new OpenAiRequestError(`Transcription failed (${response.status}): ${detail}`, response.status);
  }
  const payload = (await response.json()) as {
    text?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  };
  const text = typeof payload.text === "string" ? payload.text.trim().slice(0, MAX_TRANSCRIPT_CHARS) : "";
  const usage =
    payload.usage && typeof payload.usage.input_tokens === "number"
      ? {
          inputTokens: payload.usage.input_tokens,
          outputTokens: typeof payload.usage.output_tokens === "number" ? payload.usage.output_tokens : 0,
        }
      : null;
  return { text, usage };
}

// ----------------------------------------------------------------- prompt

/** Byte-stable (prompt caching); the frame goes in the input. The same text
 * as the backend's build_voice_system_prompt (app/utils/voice_chat.py). */
export function buildVoiceSystemPrompt(): string {
  return `
You are the FrameOS voice assistant for one smart frame. The user held two buttons on the frame and spoke; their
message is a transcript of what they said. Transcripts carry recognition errors: read for the likely intent ("the
bird journal" is the scene called Bird Field Journal). Scene names in the frame's context are the ones to match.

Act, then answer in one short sentence. The reply is not shown on the frame and is read nowhere aloud: it lands in
the frame's chat log. Never ask for confirmation and never ask a question back: the spoken request is the
confirmation, and nobody is there to answer. Do the most likely thing; when nothing matches, say so and name what
the frame has (its scenes, from list_scenes). When the transcript is empty or not a request for the frame, say
briefly that you did not catch a request.

Tools: list_scenes (what the frame holds and which scene shows), activate_scene (switch to a scene by its id),
set_scene_state (set the showing scene's public fields, such as a message board's text), render_now (redraw the
frame), show_image (put a picture on the frame: a photo found for a search, or an image generated from a
description; the frame's context says which sources it has), rotate_frame (turn the display to 0, 90, 180 or 270
degrees; "another 90" is the rotation in the context plus 90). "Next" and "previous" mean the scene after or before
the one showing, in list order, wrapping around. "Show me X" with no scene of that name is show_image. These are the
only things you can do; anything else (editing scenes, timing, other frames, the account) is for the workspace, and
you say so in a sentence.
`.trim();
}

// ------------------------------------------------------------------ tools

export const voiceToolDefinitions: ResponsesToolDefinition[] = [
  {
    description: "The scenes on this frame, in order, with their ids and which one shows now.",
    name: "list_scenes",
    parameters: { additionalProperties: false, properties: {}, type: "object" },
    type: "function",
  },
  {
    description: "Switch the frame to one of its scenes (an id from list_scenes or the context).",
    name: "activate_scene",
    parameters: {
      additionalProperties: false,
      properties: { scene_id: { description: "The scene's id.", type: "string" } },
      required: ["scene_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Set public fields of the scene the frame shows (its state), by field name, and redraw. " +
      "Only fields the scene declares; strings, numbers and booleans.",
    name: "set_scene_state",
    parameters: {
      additionalProperties: false,
      properties: {
        state: {
          additionalProperties: { type: ["string", "number", "boolean"] },
          description: "Field name to value.",
          type: "object",
        },
      },
      required: ["state"],
      type: "object",
    },
    type: "function",
  },
  {
    description: "Redraw the frame now.",
    name: "render_now",
    parameters: { additionalProperties: false, properties: {}, type: "object" },
    type: "function",
  },
  {
    description:
      "Show a picture on the frame: a photo found for a search (source photo, Unsplash) or an image " +
      "generated from a description (source generated, OpenAI). Pushes a one-picture preview scene to the " +
      "frame and shows it; the frame's other scenes stay. Only the sources the context lists work.",
    name: "show_image",
    parameters: {
      additionalProperties: false,
      properties: {
        query: {
          description: "What to show: a search for a photo, or the description to generate from.",
          type: "string",
        },
        source: {
          description: "photo for a real photograph, generated for AI art. Omit to take the first the frame has.",
          enum: ["photo", "generated"],
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Turn the frame's display to an orientation: 0, 90, 180 or 270 degrees clockwise, absolute. " +
      "The context says the current rotation; the frame restarts to apply a change.",
    name: "rotate_frame",
    parameters: {
      additionalProperties: false,
      properties: {
        degrees: { description: "The new rotation, clockwise.", enum: [0, 90, 180, 270], type: "integer" },
      },
      required: ["degrees"],
      type: "object",
    },
    type: "function",
  },
];

export const voiceToolLabels: Record<string, string> = {
  activate_scene: "Activate scene",
  list_scenes: "List scenes",
  render_now: "Render now",
  rotate_frame: "Rotate frame",
  set_scene_state: "Set scene state",
  show_image: "Show image",
};

const MAX_STATE_BYTES = 16 * 1024;
const MAX_IMAGE_QUERY_CHARS = 400;
// The contract's rule for the one setting the voice turn may change
// (docs/cloud-frames-contract.json `rotate`). The frame's render interval is
// deliberately not a voice tool: a frame sets its own, scenes have theirs, and
// a model given the key kept inventing `interval: 1` next to a rotation.
const VOICE_ROTATIONS = [0, 90, 180, 270];

// ------------------------------------------------------------ image scene

export type ImageSource = "photo" | "generated";

/** The one-picture scene show_image pushes, per source: the repo image app
 * it runs, the app field the spoken words go into, the settings group the
 * app needs, and how long the picture stays before the scene fetches another
 * (a day for a generated one: each render bills the account). The backend
 * builds the same scene (build_image_scene in voice_chat.py). */
export const imageSceneSources: Record<
  ImageSource,
  { origin: string; keyword: string; field: string; group: string; seconds: number }
> = {
  generated: {
    field: "prompt",
    group: "openAI",
    keyword: "openaiImage",
    origin: "repo/apps/image/openaiImage",
    seconds: 86400,
  },
  photo: { field: "search", group: "unsplash", keyword: "unsplash", origin: "repo/apps/image/unsplash", seconds: 3600 },
};

function imageSceneApp(origin: string): Record<string, unknown> {
  const template = appCatalog()[origin];
  if (!template?.sources || Object.keys(template.sources).length === 0) {
    throw new Error(`The ${origin} app is missing from this build.`);
  }
  const { keyword: _keyword, sources, ...config } = template;
  return { ...config, origin, sources: { ...sources } };
}

/** render event -> render/image (cover) fed by the source's app with the
 * query in its field; the app bundled into the scene like the album scene
 * (photos/album-scene.ts). */
export function buildImageScene(source: ImageSource, query: string): JsonObject {
  const spec = imageSceneSources[source];
  const ids = { app: randomUUID(), event: randomUUID(), render: randomUUID() };
  const edge = (from: string, sourceHandle: string, target: string, targetHandle: string, type: string) => ({
    id: randomUUID(),
    source: from,
    sourceHandle,
    target,
    targetHandle,
    type,
  });
  return {
    apps: { [spec.keyword]: imageSceneApp(spec.origin) },
    edges: [
      edge(ids.event, "next", ids.render, "prev", "appNodeEdge"),
      edge(ids.app, "fieldOutput", ids.render, "fieldInput/image", "codeNodeEdge"),
    ],
    fields: [],
    id: randomUUID(),
    name: `Voice: ${query}`.slice(0, 60),
    nodes: [
      { data: { keyword: "render" }, id: ids.event, position: { x: -320, y: 120 }, type: "event" },
      {
        data: { config: { placement: "cover" }, keyword: "render/image" },
        id: ids.render,
        position: { x: 200, y: 140 },
        type: "app",
      },
      {
        data: {
          cache: { duration: String(spec.seconds), durationEnabled: true, enabled: true, inputEnabled: true },
          config: { [spec.field]: query },
          keyword: spec.keyword,
        },
        id: ids.app,
        position: { x: -260, y: -200 },
        type: "app",
      },
    ],
    settings: { backgroundColor: "#000000", execution: "interpreted", refreshInterval: spec.seconds },
  };
}

/** Which show_image sources the keys the frame receives allow, photo first:
 * `settings` is the service-settings payload the device pulls
 * ({unsplash: {accessKey}, openAI: {apiKey}}, the granted groups only). */
export function imageSourcesForSettings(
  settings: Record<string, Record<string, string> | undefined>,
): ImageSource[] {
  const sources: ImageSource[] = [];
  if (settings.unsplash?.accessKey?.trim()) {
    sources.push("photo");
  }
  if (settings.openAI?.apiKey?.trim()) {
    sources.push("generated");
  }
  return sources;
}

/** The settings a voice tool may change (`rotate`, in the contract's
 * spelling), checked against its rules; an error when a value is off. */
export function validateVoiceSettings(args: JsonObject): { settings: Record<string, number> } | { error: string } {
  const settings: Record<string, number> = {};
  if ("rotate" in args) {
    const rotate = args.rotate;
    if (typeof rotate !== "number" || !VOICE_ROTATIONS.includes(rotate)) {
      return { error: "degrees must be 0, 90, 180 or 270" };
    }
    settings.rotate = rotate;
  }
  if (Object.keys(settings).length === 0) {
    return { error: "give degrees" };
  }
  return { settings };
}

export type VoiceScene = { id: string; name: string; default?: boolean };

/** What a tool asks the plane to queue, and what came of it. The route hands
 * in the implementation (its own queue), so this module stays free of the
 * database and a test can watch the calls. */
export type VoiceQueueOutcome = {
  ok: boolean;
  command_id?: string | undefined;
  type?: string | undefined;
  error?: string | undefined;
};
export type VoiceQueue = (
  type: "set_current_scene" | "scene_event" | "render",
  payload: JsonObject | undefined,
) => Promise<VoiceQueueOutcome>;

/** Push scenes to the frame as a preview with one of them showing (the
 * editor's "Preview on frame"), and change the frame's settings: the route's
 * own, like the queue. */
export type VoicePreview = (scenes: JsonObject[], sceneId: string) => Promise<VoiceQueueOutcome>;
export type VoiceSettingsUpdate = (settings: Record<string, number>) => Promise<VoiceQueueOutcome>;

export function voiceTools({
  scenes,
  activeSceneId,
  queue,
  imageSources = [],
  previewScenes,
  updateSettings,
}: {
  scenes: VoiceScene[];
  activeSceneId: string | null | undefined;
  queue: VoiceQueue;
  imageSources?: ImageSource[];
  previewScenes?: VoicePreview;
  updateSettings?: VoiceSettingsUpdate;
}): ExtraTools & { changed: string[] } {
  const changed: string[] = [];
  const text = (value: unknown): ToolOutput => ({ images: [], text: JSON.stringify(value) });
  return {
    changed,
    async call(name: string, args: JsonObject): Promise<ToolOutput> {
      switch (name) {
        case "list_scenes":
          return {
            images: [],
            text: untrustedResult(
              "frame_scenes",
              JSON.stringify({
                scenes: scenes.map((scene) => ({
                  id: scene.id,
                  name: scene.name,
                  ...(scene.default ? { default: true } : {}),
                  ...(scene.id === activeSceneId ? { showing: true } : {}),
                })),
              }),
            ),
          };
        case "activate_scene": {
          const sceneId = typeof args.scene_id === "string" ? args.scene_id : "";
          const scene = scenes.find((candidate) => candidate.id === sceneId);
          if (!scene) {
            return text({ error: "unknown_scene", ok: false, scenes: scenes.map((candidate) => candidate.id) });
          }
          const outcome = await queue("set_current_scene", { scene_id: scene.id });
          changed.push(name);
          return text({ scene: scene.name, ...outcome });
        }
        case "set_scene_state": {
          const state = args.state;
          if (!state || typeof state !== "object" || Array.isArray(state) || Object.keys(state).length === 0) {
            return text({ error: "state must be a non-empty object", ok: false });
          }
          if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) {
            return text({ error: "state too large", ok: false });
          }
          const outcome = await queue("scene_event", {
            name: "setSceneState",
            payload: { render: true, state },
          });
          changed.push(name);
          return text(outcome);
        }
        case "render_now": {
          const outcome = await queue("render", undefined);
          changed.push(name);
          return text(outcome);
        }
        case "show_image": {
          const query = typeof args.query === "string" ? args.query.trim().slice(0, MAX_IMAGE_QUERY_CHARS) : "";
          if (!query) {
            return text({ error: "query must say what to show", ok: false });
          }
          if (imageSources.length === 0 || !previewScenes) {
            return text({
              detail: "This frame has no Unsplash or OpenAI image key; the workspace's Settings add one.",
              error: "no_image_source",
              ok: false,
            });
          }
          const asked = args.source;
          const source: ImageSource =
            asked === "photo" || asked === "generated" ? asked : (imageSources[0] as ImageSource);
          if (!imageSources.includes(source)) {
            return text({ available: imageSources, error: "source_unavailable", ok: false });
          }
          const scene = buildImageScene(source, query);
          const outcome = await previewScenes([scene], scene.id as string);
          changed.push(name);
          return text({ scene: scene.name, source, ...outcome });
        }
        case "rotate_frame": {
          const validated = validateVoiceSettings({ rotate: args.degrees });
          if ("error" in validated || !updateSettings) {
            return text({
              error: "error" in validated ? validated.error : "settings cannot be changed from here",
              ok: false,
            });
          }
          const outcome = await updateSettings(validated.settings);
          changed.push(name);
          return text({
            settings: validated.settings,
            ...("rotate" in validated.settings ? { restart: true } : {}),
            ...outcome,
          });
        }
        default:
          return text({ error: `unknown tool ${name}`, ok: false });
      }
    },
    definitions: voiceToolDefinitions,
    labels: voiceToolLabels,
  };
}

// ---------------------------------------------------------------- the chat

/** The frame's voice chat: one per frame, derived from its id, so a later
 * sentence has the earlier ones as history and the workspace lists it under
 * the frame with its other chats. A uuid (chat-store's id shape) from the
 * frame id, version 5 style. */
export function voiceChatId(frameId: string): string {
  const hex = createHash("sha1").update(`frameos-voice-chat:${frameId}`).digest("hex").slice(0, 32);
  const bytes = hex.split("");
  bytes[12] = "5";
  bytes[16] = ["8", "9", "a", "b"][parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** The chat's frame context block, plus what the voice turn needs: which
 * scene shows, and that the microphone brought the message. */
export function voiceContextBlock(
  frameBlock: string,
  showing: VoiceScene | null | undefined,
  rotate = 0,
  imageSources: readonly string[] = [],
): string {
  const lines = [frameBlock];
  if (showing) {
    lines.push(
      `- Showing now: ${untrustedResult("active_scene", JSON.stringify({ id: showing.id, name: showing.name }))}`,
    );
  }
  lines.push(`- Rotation: ${rotate} degrees clockwise`);
  lines.push(`- Picture sources for show_image: ${imageSources.length > 0 ? imageSources.join(", ") : "none"}`);
  lines.push("The user spoke this into the frame's microphone; the message is the transcript.");
  return lines.join("\n");
}

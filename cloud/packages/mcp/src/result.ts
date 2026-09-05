import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CloudApiError, type FetchLike, type FrameosCloudClient } from "./client";

// What every tool hands back to the model, and how a refusal from the API
// is worded. The API's `{error: code}` bodies are precise but terse; the
// model gets the code, the status, whatever detail rode along, and — for
// the handful of codes whose fix is not obvious — a sentence on what to do.

export type ToolContext = {
  client: FrameosCloudClient;
  /**
   * Fetch for URLs the user hands us (scene zips to import). The in-process
   * host injects an SSRF-guarded one; the stdio host uses plain fetch.
   */
  fetchExternal: FetchLike;
  /** Public origin of the cloud UI, for links in tool output. */
  publicOrigin: string;
  /** Public origin of the scene store, for scene page links. */
  storeOrigin: string;
};

export function text(value: unknown): CallToolResult {
  const body =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ text: body, type: "text" }] };
}

export function structured(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value, null, 2), type: "text" }],
    structuredContent: value,
  };
}

export function image(
  bytes: Uint8Array,
  mimeType: string,
  caption?: string,
): CallToolResult {
  const content: CallToolResult["content"] = [];
  if (caption) {
    content.push({ text: caption, type: "text" });
  }
  content.push({
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
    type: "image",
  });
  return { content };
}

export function failure(message: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        text: extra ? `${message}\n${JSON.stringify(extra, null, 2)}` : message,
        type: "text",
      },
    ],
    isError: true,
  };
}

const hints: Record<string, string> = {
  api_token_not_allowed:
    "This action cannot be performed with an API token; the account owner must do it in the browser.",
  content_rejected:
    "The store's moderation refused this text or image. Reword it and try again.",
  frame_not_active:
    "The frame is pending or revoked. Pending frames need frame_confirm; revoked ones cannot be used.",
  frame_quota_exceeded:
    "The account is at its frame limit. Check account_quota; revoke a frame to free a slot (revoked frames count for 24 h).",
  cloud_rendered_frame_quota_exceeded:
    "This board has no on-device renderer (ESP32-C3, Pico), so the cloud would render every frame for it, and the account's plan allows no more such frames. Check account_quota (cloud_rendered_frames).",
  interval_below_plan_floor:
    "Cloud-rendered frames have a minimum refresh interval on this plan; use a longer interval (min_interval in the error is the floor in seconds).",
  frame_unreachable:
    "The frame did not acknowledge in time. It is offline or asleep — check frame_get for connected/next_wake_at and retry later.",
  image_unavailable:
    "The frame did not deliver a screenshot in time (offline, asleep, or still rendering). Retry in a moment.",
  invalid_scene:
    "No such scene, or it is private to another account. Use scenes_list / store_browse to find a valid id.",
  login_required:
    "The API token was refused: revoked, expired, or wrong for this server. Create a new one at /account/developer.",
  missing_api_key:
    "The AI needs an OpenAI API key: set openAI.apiKey with account_settings_update, or ask an admin about the shared key.",
  rate_limited: "Rate limited. Wait retry_after seconds and try again.",
  read_only_token:
    "This token is read-only. Mutations need a token created with full access.",
  reauth_required:
    "This action needs a fresh browser sign-in (sudo mode) and is never available to API tokens: do it at the cloud UI.",
  renderer_unavailable:
    "This server has no wasm runtime installed, so it cannot render previews.",
  scene_name_taken:
    "The account already has a scene by that name. Pick another name.",
  scene_not_found:
    "No such scene, or it belongs to another account and is private.",
  scene_quota_exceeded:
    "The account is at its scene limit. Delete scenes you no longer need (see account_quota).",
  settings_need_newer_firmware:
    "The frame's firmware is too old for one of these settings; see min_frameos_version. Update the frame first (frame_firmware_update).",
  storage_quota_exceeded:
    "The account's private scene storage is full. Delete scenes or images, or publish scenes (public scenes are free).",
  too_many_scenes:
    "The frame already holds the maximum number of scenes. Remove one first (frame_scene_remove).",
  turn_in_progress:
    "This chat already has a running AI turn. Wait for it with ai_turn_wait or cancel it with ai_turn_cancel.",
  turn_not_found:
    "The AI turn is gone: finished more than 10 minutes ago, or the server restarted. Read the chat with ai_chat_get.",
};

export function explainError(error: unknown): CallToolResult {
  if (error instanceof CloudApiError) {
    const hint = hints[error.code];
    const lines = [
      `FrameOS Cloud refused ${error.method} ${error.path}: ${error.status} ${error.code}`,
    ];
    if (hint) {
      lines.push(hint);
    }
    if (Object.keys(error.details).length > 0) {
      lines.push(JSON.stringify(error.details));
    }
    return { content: [{ text: lines.join("\n"), type: "text" }], isError: true };
  }
  if (error instanceof Error) {
    return failure(error.message);
  }
  return failure(String(error));
}

export async function run(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return explainError(error);
  }
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

// The API's own id check (any 8-4-4-4-12 hex string), not zod's RFC 4122
// version/variant check: ids are what the cloud handed out, not what a
// validator thinks a uuid should look like.
export function uuid() {
  return z.string().regex(uuidPattern, "Expected an id like 123e4567-e89b-42d3-a456-426614174000");
}

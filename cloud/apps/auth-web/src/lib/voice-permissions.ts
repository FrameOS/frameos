// What the voice chat may do on a frame (docs/voice-chat.md "What the voice
// chat may do"): the owner's four switches. Plane-side policy, never a
// firmware setting: the planes decide which tools the turn is offered. The
// cloud keeps them in frames.voice_permissions (null = the defaults), the
// backend in device_config as voiceChangeSettings / voiceUseScenes /
// voiceCreateScenes / voiceUseAlbums. The backend's copy is app/utils/voice_chat.py
// (VOICE_TOOL_PERMISSIONS, DEFAULT_VOICE_PERMISSIONS): keep both alike; the
// backend's test reads this file's sibling voice.ts, so the tables stay here
// without imports of their own.

export const voicePermissionKeys = ["change_settings", "use_scenes", "create_scenes", "use_albums"] as const;
export type VoicePermissionKey = (typeof voicePermissionKeys)[number];
export type VoicePermissions = Record<VoicePermissionKey, boolean>;

export const defaultVoicePermissions: VoicePermissions = {
  change_settings: true,
  create_scenes: false,
  use_albums: true,
  use_scenes: true,
};

// Which switch each tool answers to. A tool not listed (list_scenes) is
// always offered: it reads, and it is what the model names when it must
// decline. show_image puts a scene the frame did not hold on the frame, so it
// is a new scene, not a use of an installed one. The album tools are the
// photo library's (docs/photos.md): listing it and playing a folder on the
// frame are one switch, since the listing is what names the folder.
export const voiceToolPermissions: Record<string, VoicePermissionKey> = {
  activate_scene: "use_scenes",
  list_albums: "use_albums",
  render_now: "use_scenes",
  rotate_frame: "change_settings",
  set_scene_state: "use_scenes",
  show_album: "use_albums",
  show_image: "create_scenes",
};

// How the context names each switch to the model, on and off.
export const voicePermissionDescriptions: Record<VoicePermissionKey, string> = {
  change_settings: "change the frame's settings (rotate_frame)",
  create_scenes: "put new scenes on the frame (show_image)",
  use_albums: "play the photo albums: list them, show one on the frame (list_albums, show_album)",
  use_scenes:
    "use the installed scenes: switch between them, set their fields, redraw (activate_scene, set_scene_state, render_now)",
};

/** The stored column (or a request body) as permissions: a key that is not a
 * boolean keeps its default, anything that is not an object is the defaults. */
export function readVoicePermissions(value: unknown): VoicePermissions {
  const out: VoicePermissions = { ...defaultVoicePermissions };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  const stored = value as Record<string, unknown>;
  for (const key of voicePermissionKeys) {
    if (typeof stored[key] === "boolean") {
      out[key] = stored[key] as boolean;
    }
  }
  return out;
}

/** A partial update's valid part: the known keys that are booleans. Anything
 * else (an unknown key, a string "true") is named in `invalid`. */
export function voicePermissionsPatch(body: Record<string, unknown>): {
  patch: Partial<VoicePermissions>;
  invalid: string[];
} {
  const patch: Partial<VoicePermissions> = {};
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if ((voicePermissionKeys as readonly string[]).includes(key) && typeof value === "boolean") {
      patch[key as VoicePermissionKey] = value;
    } else {
      invalid.push(key);
    }
  }
  return { invalid, patch };
}

/** Whether the turn may be offered (and may run) this tool. */
export function voicePermissionAllows(permissions: VoicePermissions, tool: string): boolean {
  const key = voiceToolPermissions[tool];
  return key === undefined || permissions[key];
}

/** The two lines the frame's context block carries: what the owner allowed
 * and what not, each naming its tools. The same text as the backend's
 * VoicePermissions.context_lines. */
export function voicePermissionContextLines(permissions: VoicePermissions): string[] {
  const allowed = voicePermissionKeys.filter((key) => permissions[key]).map((key) => voicePermissionDescriptions[key]);
  const denied = voicePermissionKeys.filter((key) => !permissions[key]).map((key) => voicePermissionDescriptions[key]);
  return [
    `- Voice chat may: ${allowed.length > 0 ? allowed.join("; ") : "nothing but list the scenes"}`,
    `- Voice chat may not: ${denied.length > 0 ? denied.join("; ") : "nothing is switched off"}`,
  ];
}

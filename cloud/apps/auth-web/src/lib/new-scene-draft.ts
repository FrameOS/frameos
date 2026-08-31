// The unsaved scene on /my-scenes/new — what the AI just built, and the
// conversation behind it — kept in this browser so a reload does not throw
// it away. Nothing is saved server-side yet, so there is no scene id to key
// on: the draft gets an id of its own and the URL carries it in its hash
// (#d=<id>). Each tab then keeps its own draft, a reload or a Back finds
// exactly the one it left, and the draft is dropped once the scene is
// saved.
//
// Rendered frames are deliberately left out of the stored chat: each one is
// a full PNG data URL, and a handful would blow past the browser's ~5 MB
// budget. Every access is guarded — storage can be missing or full (private
// windows, quotas) and the page still has to work.

import type { SceneJson } from "./ai-scenes-apply";

export type NewSceneDraftMessage = {
  role: "user" | "assistant";
  content: string;
  /** A render-check turn the AI panel sent on the user's behalf. */
  auto?: boolean;
};

export type NewSceneDraftChat = {
  /** The server-side chat, so the next turn continues this conversation. */
  chatId: string;
  messages: NewSceneDraftMessage[];
};

export type NewSceneDraft = {
  /** The editor's scenes as last edited. */
  scenes: SceneJson[];
  /** The scene the editor had selected. */
  selectedSceneId: string | null;
  /** Index into newScenePresets: the display size that was picked. */
  presetIndex: number;
  /** The AI conversation, or null when there was none. */
  chat: NewSceneDraftChat | null;
  /** ISO timestamp of the last edit, for expiry. */
  savedAt: string;
};

export const newSceneDraftPrefix = "frameos:new-scene-draft:";

/** Drafts older than this are dropped: an unsaved scene from last month is
 * a forgotten tinker, not work in progress. */
export const newSceneDraftMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

/** A draft too big to store (localStorage quotas sit around 5 MB) is
 * skipped rather than half-written. */
export const newSceneDraftMaxBytes = 3 * 1024 * 1024;

/** How many drafts this browser keeps. Every new-scene tab that is never
 * saved leaves one behind, so the oldest are swept as new ones land. */
export const newSceneDraftsKept = 5;

export function newSceneDraftKey(draftId: string): string {
  return `${newSceneDraftPrefix}${draftId}`;
}

/** A fresh draft id: short enough to live in a URL people look at. */
export function newSceneDraftId(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2, 14);
}

/** The draft id in a URL hash (`#d=<id>`), or null when there is none. */
export function draftIdFromHash(hash: string): string | null {
  try {
    const id = new URLSearchParams(hash.replace(/^#/, "")).get("d");
    return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function hashForDraftId(draftId: string): string {
  return `#d=${draftId}`;
}

/** The stored draft, or null when there is none, it is malformed, or it has
 * expired (expired ones are removed). */
export function readNewSceneDraft(draftId: string): NewSceneDraft | null {
  try {
    const raw = window.localStorage.getItem(newSceneDraftKey(draftId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<NewSceneDraft> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.scenes) ||
      parsed.scenes.length === 0 ||
      typeof parsed.savedAt !== "string"
    ) {
      window.localStorage.removeItem(newSceneDraftKey(draftId));
      return null;
    }
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > newSceneDraftMaxAgeMs) {
      window.localStorage.removeItem(newSceneDraftKey(draftId));
      return null;
    }
    return {
      chat: readChat(parsed.chat),
      presetIndex: typeof parsed.presetIndex === "number" ? parsed.presetIndex : 0,
      savedAt: parsed.savedAt,
      scenes: parsed.scenes as SceneJson[],
      selectedSceneId:
        typeof parsed.selectedSceneId === "string" ? parsed.selectedSceneId : null,
    };
  } catch {
    return null;
  }
}

function readChat(chat: NewSceneDraft["chat"] | undefined): NewSceneDraftChat | null {
  if (!chat || typeof chat !== "object" || typeof chat.chatId !== "string") {
    return null;
  }
  const messages = (Array.isArray(chat.messages) ? chat.messages : [])
    .filter(
      (message): message is NewSceneDraftMessage =>
        Boolean(message) &&
        typeof message === "object" &&
        typeof message.content === "string" &&
        (message.role === "user" || message.role === "assistant"),
    )
    .map((message) => ({
      content: message.content,
      role: message.role,
      ...(message.auto ? { auto: true as const } : {}),
    }));
  return messages.length > 0 ? { chatId: chat.chatId, messages } : null;
}

export function writeNewSceneDraft(draftId: string, draft: NewSceneDraft) {
  try {
    const json = JSON.stringify(draft);
    if (json.length > newSceneDraftMaxBytes) {
      return;
    }
    window.localStorage.setItem(newSceneDraftKey(draftId), json);
    sweepNewSceneDrafts(draftId);
  } catch {
    // Storage missing or full: the draft just doesn't survive a reload.
  }
}

export function clearNewSceneDraft(draftId: string) {
  try {
    window.localStorage.removeItem(newSceneDraftKey(draftId));
  } catch {
    // Nothing to clear where nothing could be stored.
  }
}

function savedAtOf(raw: string | null): number {
  try {
    const savedAt = Date.parse(String((JSON.parse(raw ?? "") as { savedAt?: unknown }).savedAt));
    return Number.isFinite(savedAt) ? savedAt : 0;
  } catch {
    return 0;
  }
}

/** Drops expired drafts and everything past newSceneDraftsKept, newest
 * first, so unsaved tabs cannot pile up forever. `keep` is never swept. */
export function sweepNewSceneDrafts(keep?: string) {
  try {
    const now = Date.now();
    const found: { key: string; savedAt: number }[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith(newSceneDraftPrefix)) {
        continue;
      }
      if (keep && key === newSceneDraftKey(keep)) {
        continue;
      }
      // A malformed entry gets savedAt 0: swept as the oldest there is.
      found.push({ key, savedAt: savedAtOf(window.localStorage.getItem(key)) });
    }
    const stale = found.filter(({ savedAt }) => now - savedAt > newSceneDraftMaxAgeMs);
    const rest = found
      .filter(({ savedAt }) => now - savedAt <= newSceneDraftMaxAgeMs)
      .sort((left, right) => right.savedAt - left.savedAt)
      // The one just written counts against the budget even though it is
      // not in this list.
      .slice(keep ? newSceneDraftsKept - 1 : newSceneDraftsKept);
    for (const { key } of [...stale, ...rest]) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // A malformed entry or no storage at all: nothing to sweep.
  }
}

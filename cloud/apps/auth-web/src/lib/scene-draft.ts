// The scene workspace's unsaved edits, remembered per browser through
// localStorage so a stray navigation (a tag click, Back, a closed tab) does
// not throw them away. One draft per store scene: the edited scenes plus
// the draft listing and image set, stamped with the published version they
// were made on — a draft is only restored onto that same version, never
// onto one published since. Every access is guarded: storage can be
// missing or full (private windows, quotas) and the page must still work.

import type { SceneJson } from "./ai-scenes-apply";
import type { SceneListingData } from "../components/SceneInfoPanel";

export type SceneEditorDraft = {
  /** The editor's scenes as last edited. */
  scenes: SceneJson[];
  /** The draft listing (description, category, tags, minimum version). */
  listing: SceneListingData;
  /** The draft image set (sha256s). */
  images: string[];
  /** The published version the edits started from (null: none known). */
  baseVersion: number | null;
  /** ISO timestamp of the last edit, for expiry. */
  savedAt: string;
};

export function sceneDraftKey(sceneId: string): string {
  return `frameos:scene-draft:${sceneId}`;
}

/** Drafts older than this are dropped on read: by then the browser's copy
 * is more likely a forgotten tinker than work in progress. */
export const sceneDraftMaxAgeMs = 30 * 24 * 60 * 60 * 1000;

/** A draft too big to store (localStorage quotas sit around 5 MB) is
 * skipped rather than half-written. */
export const sceneDraftMaxBytes = 3 * 1024 * 1024;

/** The stored draft for a scene; null when there is none, it is malformed,
 * or it has expired (expired ones are removed). */
export function readSceneDraft(sceneId: string): SceneEditorDraft | null {
  try {
    const raw = window.localStorage.getItem(sceneDraftKey(sceneId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SceneEditorDraft> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.scenes) ||
      parsed.scenes.length === 0 ||
      !parsed.listing ||
      typeof parsed.listing !== "object" ||
      !Array.isArray(parsed.images) ||
      typeof parsed.savedAt !== "string"
    ) {
      window.localStorage.removeItem(sceneDraftKey(sceneId));
      return null;
    }
    const savedAt = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > sceneDraftMaxAgeMs) {
      window.localStorage.removeItem(sceneDraftKey(sceneId));
      return null;
    }
    return {
      baseVersion: typeof parsed.baseVersion === "number" ? parsed.baseVersion : null,
      images: parsed.images.filter((image): image is string => typeof image === "string"),
      listing: parsed.listing as SceneListingData,
      savedAt: parsed.savedAt,
      scenes: parsed.scenes as SceneJson[],
    };
  } catch {
    return null;
  }
}

export function writeSceneDraft(sceneId: string, draft: SceneEditorDraft) {
  try {
    const json = JSON.stringify(draft);
    if (json.length > sceneDraftMaxBytes) {
      return;
    }
    window.localStorage.setItem(sceneDraftKey(sceneId), json);
  } catch {
    // Storage missing or full: the draft just doesn't survive a navigation.
  }
}

export function clearSceneDraft(sceneId: string) {
  try {
    window.localStorage.removeItem(sceneDraftKey(sceneId));
  } catch {
    // Nothing to clear where nothing could be stored.
  }
}

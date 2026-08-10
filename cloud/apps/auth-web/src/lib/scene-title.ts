import { unzipSync } from "fflate";

// A store listing's title and the scene title inside its scenes.json are two
// copies of the same thing. The zip's template.json is what publishing reads
// (see store-publish's `manifestName`), and the FrameOS editor writes it from
// the scene's own name — so the two start out identical. These helpers let the
// owner-edit routes keep them that way when the editor renames a scene.

/** Matches the slice storeScenes.name is stored with. */
export const maxSceneNameLength = 128;

/**
 * The scenes.json inside a template interchange zip, parsed.
 *
 * The zip was validated when it was published (validateSceneZip), so this only
 * has to inflate the single file it returns; anything unexpected is reported
 * as "no scenes" rather than thrown, since callers treat it as best-effort.
 */
export function extractScenesFromZip(content: Buffer): unknown[] | undefined {
  try {
    const files = unzipSync(new Uint8Array(content), {
      filter: (file) => /(^|\/)scenes\.json$/.test(file.name),
    });
    // The shallowest scenes.json wins, mirroring validateSceneZip.
    const path = Object.keys(files).sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    )[0];
    const bytes = path ? files[path] : undefined;
    if (!bytes) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The title a scenes.json carries: the default scene's name, else the first
 * scene's. This is the name the editor's "Scene settings → Rename" changes.
 */
export function sceneDisplayName(scenes: unknown): string | undefined {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return undefined;
  }
  const isRecord = (scene: unknown): scene is Record<string, unknown> =>
    typeof scene === "object" && scene !== null && !Array.isArray(scene);
  const candidate =
    scenes.find((scene) => isRecord(scene) && scene.default === true) ??
    scenes[0];
  if (!isRecord(candidate) || typeof candidate.name !== "string") {
    return undefined;
  }
  const name = candidate.name.trim().slice(0, maxSceneNameLength);
  return name || undefined;
}

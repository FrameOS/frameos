// The live preview's Layout select (docs/scene-layouts.md "In the preview"):
// any scene can be tried inside any layout before it goes on a frame. The
// choices are the layouts among the scenes the preview runs (a frame's, a
// template that brings its own) and every layout starter, the same list the
// frame's Settings offers. Picking one makes every scene wear it, as a frame's
// active layout does, and a starter's scene goes along with them; nothing the
// editor holds changes.
import type { LayoutStarter } from "../../generated/layoutStarters";
import type { FrameScene } from "../../types";
import {
  currentSceneLayout,
  isLayoutScene,
  layoutScenes,
  withLayoutOnEveryScene,
} from "../../utils/sceneLayouts";

/** A scene as the preview runs it (frameos-wasm's FrameOSScene). */
export type PreviewLayoutScene = { id: string; name?: string | undefined } & Record<string, unknown>;

export type PreviewLayout = {
  id: string;
  name: string;
  /** The starter's scene, run beside the scenes; null for a layout already among them. */
  starter: PreviewLayoutScene | null;
};

// The 126 KB of starters (scenes and thumbnails) load with the panel, not with
// the page: the store's scene page has no other use for them.
let startersLoad: Promise<readonly LayoutStarter[]> | null = null;

/** The layout starters, loaded once; none when the chunk cannot be fetched. */
export function loadLayoutStarters(): Promise<readonly LayoutStarter[]> {
  startersLoad ??= import("../../generated/layoutStarters").then(
    (module) => module.LAYOUT_STARTERS,
    () => {
      startersLoad = null;
      return [];
    },
  );
  return startersLoad;
}

function asFrameScenes(scenes: readonly PreviewLayoutScene[]): FrameScene[] {
  return scenes as unknown as FrameScene[];
}

/**
 * What the select offers, in order: the layouts among the scenes, then each
 * starter that is not one of them already (by id, or by name: a frame that
 * added "Windows 98" holds it under an id of its own).
 */
export function previewLayouts(
  scenes: readonly PreviewLayoutScene[],
  starters: readonly { name: string; scene: { id: string } }[],
): PreviewLayout[] {
  const own: PreviewLayout[] = layoutScenes(asFrameScenes(scenes)).map((scene) => ({
    id: scene.id,
    name: scene.name || scene.id,
    starter: null,
  }));
  const ownIds = new Set(own.map((layout) => layout.id));
  const ownNames = new Set(own.map((layout) => layout.name));
  const samples: PreviewLayout[] = starters
    .filter((starter) => !ownIds.has(starter.scene.id) && !ownNames.has(starter.name))
    .map((starter) => ({
      id: starter.scene.id,
      name: starter.name,
      starter: starter.scene as unknown as PreviewLayoutScene,
    }));
  return [...own, ...samples];
}

/** The layout `sceneId` wears among `scenes` (`""`: none, or one the scenes do not hold). */
export function wornPreviewLayout(
  scenes: readonly PreviewLayoutScene[],
  sceneId: string | null | undefined,
): string {
  const frameScenes = asFrameScenes(scenes);
  const scene = frameScenes.find((candidate) => candidate.id === sceneId);
  return currentSceneLayout(scene, layoutScenes(frameScenes))?.sceneId ?? "";
}

/** Whether the scene is itself a layout: then there is nothing to wrap. */
export function isPreviewLayout(scene: PreviewLayoutScene | null | undefined): boolean {
  return isLayoutScene(scene as unknown as FrameScene | null | undefined);
}

/**
 * What the preview runs with `layoutId` chosen (`""`: no layout): every scene
 * that is not a layout wears it, keeping the settings it already gave that
 * layout, and a starter's scene is added. An id that is not on offer is no
 * layout.
 */
export function scenesWithPreviewLayout<T extends PreviewLayoutScene>(
  scenes: readonly T[],
  layouts: readonly PreviewLayout[],
  layoutId: string,
): T[] {
  const chosen = layouts.find((layout) => layout.id === layoutId) ?? null;
  const worn = withLayoutOnEveryScene(asFrameScenes(scenes), chosen?.id ?? "") as unknown as T[];
  return chosen?.starter ? [...worn, chosen.starter as T] : worn;
}

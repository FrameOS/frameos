// The live preview's Layout select (docs/scene-layouts.md "In the preview"):
// any scene can be tried inside any layout before it goes on a frame. The
// choices are the layouts among the scenes the preview runs (a frame's, a
// template that brings its own) and every layout starter, the same list the
// frame's Settings offers. Picking one makes every scene wear it, as a frame's
// active layout does, and a starter's scene goes along with them; nothing the
// editor holds changes. "Layout settings" beside it sets the layout's fields for
// the preview, over what each scene gives the layout it wears; this browser
// remembers them per layout.
import type { LayoutStarter } from "../../generated/layoutStarters";
import type { FrameScene } from "../../types";
import {
  currentSceneLayout,
  isDesktopLayout,
  isLayoutScene,
  layoutGroups,
  layoutScenes,
  sceneLayoutRef,
  withLayoutOnEveryScene,
  withSceneLayout,
} from "../../utils/sceneLayouts";
import type { LayoutGroup } from "../../utils/sceneLayouts";

/** A scene as the preview runs it (frameos-wasm's FrameOSScene). */
export type PreviewLayoutScene = { id: string; name?: string | undefined } & Record<string, unknown>;

export type PreviewLayout = {
  id: string;
  name: string;
  /** A desktop (`settings.desktop`): the select lists it apart from the full screen layouts. */
  desktop: boolean;
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
  starters: readonly { name: string; scene: { id: string; settings?: unknown } }[],
): PreviewLayout[] {
  const own: PreviewLayout[] = layoutScenes(asFrameScenes(scenes)).map((scene) => ({
    id: scene.id,
    name: scene.name || scene.id,
    desktop: isDesktopLayout(scene),
    starter: null,
  }));
  const ownIds = new Set(own.map((layout) => layout.id));
  const ownNames = new Set(own.map((layout) => layout.name));
  const samples: PreviewLayout[] = starters
    .filter((starter) => !ownIds.has(starter.scene.id) && !ownNames.has(starter.name))
    .map((starter) => ({
      id: starter.scene.id,
      name: starter.name,
      desktop: isDesktopLayout(starter.scene as unknown as FrameScene),
      starter: starter.scene as unknown as PreviewLayoutScene,
    }));
  return [...own, ...samples];
}

/** The select's choices as the frame's settings list them: the desktops, then the full screen layouts. */
export function previewLayoutGroups(layouts: readonly PreviewLayout[]): LayoutGroup<PreviewLayout>[] {
  return layoutGroups(layouts, (layout) => layout.desktop);
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
 * The values set in the preview's Layout settings, by layout id: only the
 * fields changed there, as the form gives them.
 */
export type PreviewLayoutSettings = Record<string, Record<string, unknown>>;

/** Where this browser remembers them. */
export const PREVIEW_LAYOUT_SETTINGS_STORAGE_KEY = "frameos.preview.layoutSettings";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Remembered settings as stored (JSON text, or null); anything else is none. */
export function parsePreviewLayoutSettings(stored: string | null | undefined): PreviewLayoutSettings {
  if (!stored) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) {
    return {};
  }
  const settings: PreviewLayoutSettings = {};
  for (const [layoutId, values] of Object.entries(parsed)) {
    if (layoutId && isPlainObject(values) && Object.keys(values).length > 0) {
      settings[layoutId] = { ...values };
    }
  }
  return settings;
}

/**
 * Whether a change of a field of this type goes to the preview at once (a
 * checkbox, a menu), not after a pause in the typing. Each change boots the
 * runtime again.
 */
export function layoutSettingAppliesAtOnce(type: string | undefined): boolean {
  return type === "boolean" || type === "select" || type === "font";
}

/** `settings` with one field of one layout set. */
export function withPreviewLayoutSetting(
  settings: PreviewLayoutSettings,
  layoutId: string,
  name: string,
  value: unknown,
): PreviewLayoutSettings {
  return { ...settings, [layoutId]: { ...settings[layoutId], [name]: value } };
}

/** `settings` with nothing set for this layout: back to what the scenes give it. */
export function withoutPreviewLayoutSettings(
  settings: PreviewLayoutSettings,
  layoutId: string,
): PreviewLayoutSettings {
  if (!(layoutId in settings)) {
    return settings;
  }
  const { [layoutId]: _dropped, ...rest } = settings;
  return rest;
}

/** The scene of a layout on offer: the starter's, or the one among the scenes. */
export function previewLayoutScene(
  scenes: readonly PreviewLayoutScene[],
  layouts: readonly PreviewLayout[],
  layoutId: string,
): PreviewLayoutScene | null {
  const layout = layouts.find((candidate) => candidate.id === layoutId);
  if (!layout) {
    return null;
  }
  return layout.starter ?? scenes.find((scene) => scene.id === layoutId) ?? null;
}

/** The state `sceneId` gives `layoutId` when it wears it (an install's settings), else none. */
export function wornPreviewLayoutState(
  scenes: readonly PreviewLayoutScene[],
  sceneId: string | null | undefined,
  layoutId: string,
): Record<string, unknown> {
  const ref = sceneLayoutRef(scenes.find((scene) => scene.id === sceneId)?.["layout"]);
  return ref?.sceneId === layoutId ? { ...ref.state } : {};
}

/**
 * Every scene wearing a layout that has settings here gets them over the
 * state it gives that layout itself. The same list when none applies.
 */
export function withPreviewLayoutSettings<T extends PreviewLayoutScene>(
  scenes: readonly T[],
  settings: PreviewLayoutSettings,
): T[] {
  let changed = false;
  const dressed = scenes.map((scene) => {
    if (isPreviewLayout(scene)) {
      return scene;
    }
    const ref = sceneLayoutRef(scene["layout"]);
    const values = ref ? settings[ref.sceneId] : undefined;
    if (!ref || !values || Object.keys(values).length === 0) {
      return scene;
    }
    changed = true;
    return withSceneLayout(scene as unknown as Partial<FrameScene>, {
      sceneId: ref.sceneId,
      state: { ...ref.state, ...values },
    }) as unknown as T;
  });
  return changed ? dressed : (scenes as T[]);
}

/**
 * What the preview runs with `layoutId` chosen (`null`: what each scene
 * wears, `""`: no layout): every scene that is not a layout wears it, keeping
 * the settings it already gave that layout, and a starter's scene is added. An
 * id that is not on offer is no layout. The Layout settings go over the state
 * of every layout they are for.
 */
export function scenesWithPreviewLayout<T extends PreviewLayoutScene>(
  scenes: readonly T[],
  layouts: readonly PreviewLayout[],
  layoutId: string | null,
  settings: PreviewLayoutSettings = {},
): T[] {
  if (layoutId === null) {
    return withPreviewLayoutSettings(scenes, settings);
  }
  const chosen = layouts.find((layout) => layout.id === layoutId) ?? null;
  const worn = withPreviewLayoutSettings(
    withLayoutOnEveryScene(asFrameScenes(scenes), chosen?.id ?? "") as unknown as T[],
    settings,
  );
  return chosen?.starter ? [...worn, chosen.starter as T] : worn;
}

import { keyFlagNamespace, sceneAccessFlags } from '../../../frontend/src/utils/sceneAccess'
import { sceneNeeds, type SceneNeed } from '../../../frontend/src/utils/sceneNeeds'
import { storeCategoryShelves } from '../../../frontend/src/utils/storeCategories'

// The samples flash.frameos.net offers a standalone ESP32 (cloud/docs/flasher.md
// "A standalone frame"): every sample of repo/scenes the store carries that can
// run on such a frame. cloud-frontend/build.mjs runs this over the repo at build
// time and writes a light index (this file's FlasherSample, no scene JSON) and
// one file of scenes per sample, fetched only for the samples picked.
//
// What a standalone frame cannot run is read from the scenes themselves, never
// from a list of names: a layout (it shows nothing of its own), a scene that
// needs a Raspberry Pi (`linux`: a program on the frame; `video`: ffmpeg), and a
// scene whose apps read an account's key (`key:<service>`, sceneAccess.ts): a
// frame with no plane is given no keys.

/** One sample as build.mjs reads it from repo/scenes. */
export interface FlasherSampleSource {
  /** The sample's folder name: what the flasher knows it by (its picks, its file). */
  name: string
  /** Its template.json name: what the scene is called, here and on the Scene store. */
  title: string
  description: string
  /** Whether its template.json names a picture of it that is there. */
  hasImage: boolean
  scenes: Record<string, unknown>[]
}

/** One sample the flasher offers. */
export interface FlasherSample {
  /** Its folder name: what a pick names. */
  name: string
  /** What it is called, as the list shows it and the Scene store lists it. */
  title: string
  description: string
  /** Its scenes' `settings.category` (the first one that names one), else "Other". */
  category: string
  /** What its scenes need of the frame (sceneNeeds.ts), `round` left out. */
  needs: SceneNeed[]
  /** Its scenes as the board is sent them: compact JSON, in bytes. */
  bytes: number
  /** How many scenes it adds. */
  scenes: number
  /** Where its scenes are served, relative to the index. */
  file: string
  /** Where a small picture of it is served, relative to the index, when it has one. */
  thumb: string | null
  /** The Scene store: always on the frame, so it can install the rest itself. */
  store: boolean
}

export type FlasherSampleLeftOut = 'layout' | 'pi' | 'video' | 'key' | 'empty'

/** One layout the flasher offers (docs/scene-layouts.md): a sample whose one
 * scene is a layout. Every scene the frame starts with wears it. */
export interface FlasherLayout {
  /** Its folder name: what a pick names, and the build's file for it. */
  name: string
  /** Its scene's name, as the frame's settings list it ("Windows 98"). */
  title: string
  description: string
  /** The layout scene's id: what each scene's `layout.sceneId` names. */
  id: string
  /** A desktop: it runs the frame's scenes in windows (`settings.desktop`). */
  desktop: boolean
  /** The boards it is made for (`settings.devices`, hardware ids); none for any. */
  devices: string[]
  /** Its scene as the board is sent it: compact JSON, in bytes. */
  bytes: number
  file: string
  thumb: string | null
}

export interface FlasherSampleIndex {
  samples: FlasherSample[]
  /** The layouts, made for a device first, then the desktops, then the rest, each by title. */
  layouts: FlasherLayout[]
  /** What was left out and why, for the build's log and the tests (a layout among them). */
  leftOut: { name: string; why: FlasherSampleLeftOut }[]
}

/** The Scene store's scene id (repo/scenes/samples/Scene store). */
export const SCENE_STORE_ID = 'scene-store'

export const OTHER_CATEGORY = 'Other'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function settingsOf(scene: Record<string, unknown>): Record<string, unknown> {
  return isRecord(scene.settings) ? scene.settings : {}
}

function isLayout(scene: Record<string, unknown>): boolean {
  return settingsOf(scene).isLayout === true
}

// A sample that plays a video as one thing among many, which the data cannot
// tell from a video player: Files opens every kind of file, and its viewer
// says it cannot play a video on an ESP32 (docs/video.md).
const VIDEO_AMONG_OTHERS = new Set(['Files'])

/** Why a sample is not offered to a standalone frame, or null when it is. */
export function flasherSampleLeftOut(source: FlasherSampleSource): FlasherSampleLeftOut | null {
  const shown = source.scenes.filter((scene) => !isLayout(scene))
  if (source.scenes.length === 0) {
    return 'empty'
  }
  if (shown.length === 0) {
    return 'layout'
  }
  return standaloneCannotRun(source)
}

/** What a standalone frame cannot run of a sample's scenes, or null. */
function standaloneCannotRun(source: FlasherSampleSource): FlasherSampleLeftOut | null {
  const needs = sceneNeeds(source.scenes)
  if (needs.includes('linux')) {
    return 'pi'
  }
  if (needs.includes('video') && !VIDEO_AMONG_OTHERS.has(source.name)) {
    return 'video'
  }
  const flags = sceneAccessFlags(source.scenes)
  if (flags.includes('shell')) {
    return 'pi'
  }
  if (flags.some((flag) => keyFlagNamespace(flag) !== null)) {
    return 'key'
  }
  return null
}

/** The layout a sample is, when it is one scene that is a layout a standalone
 * frame can run; else null. */
export function flasherLayoutOf(source: FlasherSampleSource): Omit<FlasherLayout, 'file' | 'thumb' | 'bytes'> | null {
  const [scene] = source.scenes
  if (source.scenes.length !== 1 || !scene || !isLayout(scene) || standaloneCannotRun(source) !== null) {
    return null
  }
  const settings = settingsOf(scene)
  const id = typeof scene.id === 'string' ? scene.id : ''
  if (!id) {
    return null
  }
  const name = typeof scene.name === 'string' && scene.name.trim() ? scene.name.trim() : source.title.trim()
  return {
    name: source.name,
    title: name || source.name,
    description: source.description,
    id,
    desktop: settings.desktop === true,
    devices: Array.isArray(settings.devices)
      ? settings.devices.filter((device): device is string => typeof device === 'string' && device.length > 0)
      : [],
  }
}

function compareFlasherLayouts(a: FlasherLayout, b: FlasherLayout): number {
  const rank = (layout: FlasherLayout): number => (layout.devices.length > 0 ? 0 : layout.desktop ? 1 : 2)
  return rank(a) - rank(b) || a.title.localeCompare(b.title)
}

/** The file a sample's scenes are served at: its name, made safe for a URL. */
export function flasherSampleFile(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'sample'}.json`
}

/** The small picture of a sample build.mjs serves beside its scenes. */
export function flasherSampleThumb(name: string): string {
  return flasherSampleFile(name).replace(/\.json$/, '.jpg')
}

/** The size of that picture: twice the list's 64 x 48 slot. */
export const FLASHER_THUMB_WIDTH = 128
export const FLASHER_THUMB_HEIGHT = 96

/** The JSON a sample's scenes go to the board as: compact. */
export function flasherScenesJson(scenes: readonly Record<string, unknown>[]): string {
  return JSON.stringify(scenes)
}

function categoryOf(scenes: readonly Record<string, unknown>[]): string {
  for (const scene of scenes) {
    const category = settingsOf(scene).category
    if (typeof category === 'string' && category.trim()) {
      return category.trim()
    }
  }
  return OTHER_CATEGORY
}

/**
 * Where a category goes in the list: "System" first (the frame's own tools, as
 * the scene switcher puts them), then the store's shelves in their order, then
 * any other name, "Other" last.
 */
export function flasherCategoryRank(category: string): number {
  if (category === 'System') {
    return -1
  }
  const shelf = storeCategoryShelves.findIndex((entry) => entry.title === category)
  if (shelf >= 0) {
    return shelf
  }
  return category === OTHER_CATEGORY ? storeCategoryShelves.length + 1 : storeCategoryShelves.length
}

export function compareFlasherCategories(a: string, b: string): number {
  return flasherCategoryRank(a) - flasherCategoryRank(b) || a.localeCompare(b)
}

/**
 * The flasher's index of `sources`: the Scene store first, then by category and
 * name, and the layouts beside them. Throws when two offered samples or layouts
 * share a scene id (picked together they would be one scene) or when there is
 * no Scene store (a frame could install nothing).
 */
export function flasherSampleIndex(sources: readonly FlasherSampleSource[]): FlasherSampleIndex {
  const samples: FlasherSample[] = []
  const layouts: FlasherLayout[] = []
  const leftOut: FlasherSampleIndex['leftOut'] = []
  const ids = new Map<string, string>()
  const files = new Set<string>()
  const served = (name: string): string => {
    const file = flasherSampleFile(name)
    if (files.has(file)) {
      throw new Error(`two flasher samples are served as ${file}`)
    }
    files.add(file)
    return file
  }
  for (const source of sources) {
    const why = flasherSampleLeftOut(source)
    if (why) {
      leftOut.push({ name: source.name, why })
      const layout = why === 'layout' ? flasherLayoutOf(source) : null
      if (layout) {
        const other = ids.get(layout.id)
        if (other !== undefined) {
          throw new Error(`flasher samples "${other}" and "${source.name}" share the scene id "${layout.id}"`)
        }
        ids.set(layout.id, source.name)
        layouts.push({
          ...layout,
          bytes: new TextEncoder().encode(flasherScenesJson(source.scenes)).byteLength,
          file: served(source.name),
          thumb: source.hasImage ? flasherSampleThumb(source.name) : null,
        })
      }
      continue
    }
    for (const scene of source.scenes) {
      const id = typeof scene.id === 'string' ? scene.id : ''
      if (!id) {
        throw new Error(`flasher sample "${source.name}" has a scene with no id`)
      }
      const other = ids.get(id)
      if (other !== undefined) {
        throw new Error(`flasher samples "${other}" and "${source.name}" share the scene id "${id}"`)
      }
      ids.set(id, source.name)
    }
    const file = served(source.name)
    samples.push({
      name: source.name,
      title: source.title.trim() || source.name,
      description: source.description,
      category: categoryOf(source.scenes.filter((scene) => !isLayout(scene))),
      needs: sceneNeeds(source.scenes).filter((need) => need !== 'round'),
      bytes: new TextEncoder().encode(flasherScenesJson(source.scenes)).byteLength,
      scenes: source.scenes.length,
      file,
      thumb: source.hasImage ? flasherSampleThumb(source.name) : null,
      store: source.scenes.some((scene) => scene.id === SCENE_STORE_ID),
    })
  }
  if (!samples.some((sample) => sample.store)) {
    throw new Error('the flasher offers no Scene store sample')
  }
  samples.sort(
    (a, b) =>
      Number(b.store) - Number(a.store) ||
      compareFlasherCategories(a.category, b.category) ||
      a.title.localeCompare(b.title)
  )
  layouts.sort(compareFlasherLayouts)
  return { samples, layouts, leftOut }
}

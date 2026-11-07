import type { AppNodeData, FrameScene } from '../types'

// The embedded editor's file tree: a template is a folder of files, the way
// its zip is — template.json (the listing), then each scene as a diagram
// with its apps as folders beneath it. The pure half (what the tree lists)
// lives here so the shared-spa tests can pin it without a DOM.

/** One app node of a scene, as a folder in the tree. */
export interface SceneAppEntry {
  nodeId: string
  /** The folder's name: the node's own name, else the app's, else its keyword. */
  label: string
  keyword: string
  /** `scene`: the scene carries the source (a JS app, or an inline one) and
   * it is edited here; `builtin`: an app from the FrameOS catalog, shown
   * read only. */
  source: 'scene' | 'builtin'
}

/** What the tree has open in the file pane. A scene's diagram is the scene
 * the editor shows (its own `selectedSceneId`), so `diagram` names none. */
export type SceneFileSelection =
  | { kind: 'template' }
  | { kind: 'diagram' }
  | { kind: 'app'; sceneId: string; nodeId: string }

/** The template's listing, as its template.json carries it (the store
 * zip's manifest), minus the paths to its other files. */
export interface SceneTemplateMetadata {
  name: string
  description: string | null
  category: string | null
  tags: string[]
  /** The oldest FrameOS that runs the template's scenes (e.g. "2026.11.3"). */
  frameosVersion: string | null
}

/** A tree key for a scene's folder of apps. */
export function sceneTreeKey(sceneId: string): string {
  return `scene:${sceneId}`
}

/** A tree key for an app's folder of files. */
export function appTreeKey(sceneId: string, nodeId: string): string {
  return `app:${sceneId}.${nodeId}`
}

/** The file name a scene's diagram goes by in the tree. */
export function sceneFileName(scene: Pick<FrameScene, 'id' | 'name'>): string {
  return `${scene.name?.trim() || scene.id}.scene`
}

function keywordLabel(keyword: string): string {
  const last = keyword.split('/').filter(Boolean).pop()
  return last || keyword
}

/** The scene's app nodes as the tree lists them, in diagram order. Two
 * nodes of one name get their node id beside it, so neither hides the
 * other. */
export function sceneAppEntries(scene: FrameScene | null | undefined): SceneAppEntry[] {
  if (!scene) {
    return []
  }
  const entries: SceneAppEntry[] = []
  for (const node of scene.nodes ?? []) {
    if (node.type !== 'app') {
      continue
    }
    const data = (node.data ?? {}) as Partial<AppNodeData>
    const keyword = typeof data.keyword === 'string' ? data.keyword : ''
    const sceneApp = keyword ? scene.apps?.[keyword] : undefined
    const label =
      (typeof data.name === 'string' && data.name.trim()) ||
      (typeof sceneApp?.name === 'string' && sceneApp.name.trim()) ||
      (keyword ? keywordLabel(keyword) : '') ||
      node.id
    entries.push({
      nodeId: node.id,
      label,
      keyword,
      source: data.sources || sceneApp ? 'scene' : 'builtin',
    })
  }
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1)
  }
  return entries.map((entry) =>
    (counts.get(entry.label) ?? 0) > 1 ? { ...entry, label: `${entry.label} (${entry.nodeId})` } : entry
  )
}

/** The selection the pane can actually show: an app whose node is gone
 * (deleted on the diagram, or a re-init swapped the scenes) falls back to
 * its scene's diagram. */
export function shownSelection(selection: SceneFileSelection, scenes: FrameScene[]): SceneFileSelection {
  if (selection.kind !== 'app') {
    return selection
  }
  const scene = scenes.find((candidate) => candidate.id === selection.sceneId)
  const node = scene?.nodes?.find((candidate) => candidate.id === selection.nodeId)
  return node && node.type === 'app' ? selection : { kind: 'diagram' }
}

/** The template.json the form edits, as JSON text (the Source view). */
export function templateJsonText(template: SceneTemplateMetadata): string {
  const manifest: Record<string, unknown> = { name: template.name }
  if (template.description) {
    manifest.description = template.description
  }
  if (template.category) {
    manifest.category = template.category
  }
  if (template.tags.length > 0) {
    manifest.tags = template.tags
  }
  if (template.frameosVersion) {
    manifest.frameosVersion = template.frameosVersion
  }
  manifest.scenes = './scenes.json'
  return JSON.stringify(manifest, null, 2)
}

/** The listing changes an edited template.json asks for, or an error to
 * show beside the source. The name is the scene's (it is renamed in the
 * bar), so a changed name is reported, not applied. */
export function templateChangesFromJson(
  text: string,
  current: SceneTemplateMetadata
): { changes: Partial<SceneTemplateMetadata> } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'template.json is an object' }
  }
  const manifest = parsed as Record<string, unknown>
  if (manifest.name !== undefined && manifest.name !== current.name) {
    return { error: "The name follows the scene's: rename it from the bar" }
  }
  const optionalString = (key: string): string | null | { error: string } => {
    const value = manifest[key]
    if (value === undefined || value === null || value === '') {
      return null
    }
    return typeof value === 'string' ? value : { error: `"${key}" is a string` }
  }
  const description = optionalString('description')
  const category = optionalString('category')
  const frameosVersion = optionalString('frameosVersion')
  for (const value of [description, category, frameosVersion]) {
    if (value && typeof value === 'object') {
      return value
    }
  }
  const tags = manifest.tags ?? []
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    return { error: '"tags" is a list of strings' }
  }
  const next: SceneTemplateMetadata = {
    name: current.name,
    description: description as string | null,
    category: category as string | null,
    frameosVersion: frameosVersion as string | null,
    tags: tags as string[],
  }
  const changes: Partial<SceneTemplateMetadata> = {}
  if (next.description !== current.description) {
    changes.description = next.description
  }
  if (next.category !== current.category) {
    changes.category = next.category
  }
  if (next.frameosVersion !== current.frameosVersion) {
    changes.frameosVersion = next.frameosVersion
  }
  if (JSON.stringify(next.tags) !== JSON.stringify(current.tags)) {
    changes.tags = next.tags
  }
  return { changes }
}

/**
 * What a scene reaches for on the frame, read from the scene's own JSON: the
 * asset access it declares (`settings.assetAccess`), what its content uses,
 * and the flags every surface shows next to its name ("runs shell commands",
 * "reads assets folder", "reads all files"). Content, not provenance: the
 * answer travels with every copy of the scene and anyone can check it in the
 * JSON. Installing a scene that shows a flag is the approval.
 *
 * One implementation for the SPA (both control planes) and for the cloud
 * store's publish-time `risk_flags` (cloud/apps/auth-web/src/lib/store.ts).
 * docs/scene-access-fixtures.json is the corpus it is tested against.
 *
 * The frame enforces the explicit values (frameos/src/frameos/asset_scope.nim):
 * "cache-home-only" holds the scene to `<assets>/scenes/<sceneId>/`,
 * "all-assets" keeps `data/localImage` inside the assets folder. "auto" is
 * detection only: a scene that hides its asset calls (`frameos["read" + "Asset"]`)
 * is not caught here, and nothing on the frame stops it yet.
 *
 * Plain TypeScript on unknown input, no imports: the cloud server compiles it
 * under its stricter tsconfig.
 */

export const ASSET_ACCESS_VALUES = ['auto', 'cache-home-only', 'all-assets', 'all-files'] as const
export type AssetAccess = (typeof ASSET_ACCESS_VALUES)[number]

/** How far a scene reaches into the frame's files, narrowest first. */
export type AssetReach = 'none' | 'home' | 'assets' | 'files'

export type SceneAccessFlag = 'shell' | 'assets' | 'files'
export const SCENE_ACCESS_FLAGS: readonly SceneAccessFlag[] = ['shell', 'files', 'assets']

export const sceneAccessFlagLabels: Record<SceneAccessFlag, string> = {
  shell: 'runs shell commands',
  assets: 'reads assets folder',
  files: 'reads all files',
}

export const sceneAccessFlagDescriptions: Record<SceneAccessFlag, string> = {
  shell: 'This scene configures apps or code that run shell commands on the frame.',
  assets:
    "This scene reads and writes the frame's assets folder: uploaded photos, fonts and what other scenes saved there.",
  files: 'This scene can read any file on the frame, outside the assets folder too.',
}

export const assetAccessLabels: Record<AssetAccess, string> = {
  auto: 'Auto',
  'cache-home-only': 'Own folder only',
  'all-assets': 'All assets',
  'all-files': 'All files',
}

/**
 * A "cache-home-only" scene's folder, relative to the frame's assets folder.
 * The frame flattens the id the same way (sceneSubtreeName in
 * frameos/src/frameos/asset_scope.nim), so one scene cannot name another's.
 */
export function sceneHomeFolder(sceneId: string): string {
  return `scenes/${sceneId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/** Where the frame keeps its assets unless frame.json says otherwise. */
export const DEFAULT_ASSETS_PATH = '/srv/assets'

const declaredReach: Record<AssetAccess, AssetReach | null> = {
  auto: null,
  'cache-home-only': 'home',
  'all-assets': 'assets',
  'all-files': 'files',
}

const reachOrder: Record<AssetReach, number> = { none: 0, home: 1, assets: 2, files: 3 }

// Apps known to shell out (data/chromiumScreenshot, data/rstpSnapshot) and the
// process APIs a code node or an edited app source could call. A warning, not
// a sandbox: absence of the flag is no guarantee.
const shellAppKeywordPattern = /(shell|exec|terminal|command|chromiumscreenshot|rstpsnapshot)/i
const shellCodePattern =
  /\b(execShellCmd|execCmdEx|execCmd|execProcess|startProcess|runShellWithParentStreams|runShellCapture|osproc|quoteShell|child_process)\b/

// The `frameos` calls that reach the assets folder (frontend/src/utils/appTypeDeclarations.ts).
// `fetchImage({saveAsset})` is not one of them: that is the frame caching
// what it downloaded, not the scene reading the folder.
const assetApiPattern =
  /\b(listAssets|assetExists|assetSize|readAsset|writeAsset|appendAsset|deleteAsset|loadAssetImage|openAssetStream)\b/

const localImageKeywordPattern = /(^|\/)localImage$/

export interface SceneAccess {
  /** `settings.assetAccess`, "auto" when unset or not a known value. */
  declared: AssetAccess
  /** What the scene's content reaches for, whatever it declares. */
  detected: AssetReach
  /** The declared reach, or the detected one for "auto": what the flags show. */
  effective: AssetReach
  /** Why `detected` is what it is, one short line per finding. */
  reasons: string[]
  shell: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function declaredAssetAccess(scene: unknown): AssetAccess {
  // Trimmed, like the frame (normalizedAssetAccess in asset_scope.nim).
  const raw = record(record(scene)?.['settings'])?.['assetAccess']
  const value = typeof raw === 'string' ? raw.trim() : ''
  return (ASSET_ACCESS_VALUES as readonly string[]).includes(value) ? (value as AssetAccess) : 'auto'
}

function wider(a: AssetReach, b: AssetReach): AssetReach {
  return reachOrder[b] > reachOrder[a] ? b : a
}

/**
 * Where a `data/localImage` path points, as the frame reads it when nothing
 * confines the scene: empty means the assets folder, an absolute path is
 * taken as written, a relative one is relative to the runtime's working
 * directory (not the assets folder).
 */
export function localImagePathReach(path: string, assetsPath: string = DEFAULT_ASSETS_PATH): AssetReach {
  const trimmed = path.trim()
  if (trimmed === '') {
    return 'assets'
  }
  if (trimmed.startsWith('sd://')) {
    return trimmed.split('/').includes('..') ? 'files' : 'assets'
  }
  if (!trimmed.startsWith('/') || trimmed.split('/').includes('..')) {
    return 'files'
  }
  const root = assetsPath.replace(/\/+$/, '')
  return trimmed === root || trimmed.startsWith(root + '/') ? 'assets' : 'files'
}

export function sceneAccess(scene: unknown): SceneAccess {
  const declared = declaredAssetAccess(scene)
  const reasons: string[] = []
  let detected: AssetReach = 'none'
  let shell = false
  const sceneRecord = record(scene)
  const nodes = Array.isArray(sceneRecord?.['nodes']) ? (sceneRecord?.['nodes'] as unknown[]) : []
  const edges = Array.isArray(sceneRecord?.['edges']) ? (sceneRecord?.['edges'] as unknown[]) : []

  const wiredPaths = new Set<string>()
  for (const edge of edges) {
    const edgeRecord = record(edge)
    if (edgeRecord?.['targetHandle'] === 'fieldInput/path' && typeof edgeRecord['target'] === 'string') {
      wiredPaths.add(edgeRecord['target'])
    }
  }

  for (const node of nodes) {
    const nodeRecord = record(node)
    const data = record(nodeRecord?.['data'])
    const keyword = data?.['keyword']
    if (typeof keyword !== 'string') {
      continue
    }
    if (shellAppKeywordPattern.test(keyword)) {
      shell = true
    }
    if (nodeRecord?.['type'] !== 'app' || !localImageKeywordPattern.test(keyword)) {
      continue
    }
    const nodeId = nodeRecord['id']
    if (typeof nodeId === 'string' && wiredPaths.has(nodeId)) {
      detected = wider(detected, 'files')
      reasons.push('a Local Image node takes its path from another node, so it can name any folder')
      continue
    }
    const configured = record(data?.['config'])?.['path']
    const path = typeof configured === 'string' ? configured : ''
    const reach = localImagePathReach(path)
    detected = wider(detected, reach)
    reasons.push(
      reach === 'files'
        ? `a Local Image node reads ${path.trim()}, outside the assets folder`
        : `a Local Image node reads ${path.trim() || 'the assets folder'}`
    )
  }

  // A full-text sweep: code nodes, the scene's own app sources and config
  // values, wherever the calls hide in the graph.
  let text = ''
  try {
    text = JSON.stringify(scene) ?? ''
  } catch {
    text = ''
  }
  if (shellCodePattern.test(text)) {
    shell = true
  }
  const assetCall = assetApiPattern.exec(text)
  if (assetCall) {
    detected = wider(detected, 'assets')
    reasons.push(`its code calls frameos.${assetCall[1]}`)
  }

  const explicit = declaredReach[declared]
  return { declared, detected, effective: explicit ?? detected, reasons, shell }
}

/**
 * The scene declares less than its content reaches for, and the frame will
 * refuse the rest: a Local Image path outside what "cache-home-only" or
 * "all-assets" allows. (Asset calls under "cache-home-only" are not refused,
 * they land in the scene's own folder.)
 */
export function assetAccessRefusesContent(access: SceneAccess): boolean {
  return (access.declared === 'cache-home-only' || access.declared === 'all-assets') && access.detected === 'files'
}

/** The flags one scene shows; "reads all files" covers "reads assets folder". */
export function sceneAccessFlagsForScene(scene: unknown): SceneAccessFlag[] {
  const access = sceneAccess(scene)
  const flags: SceneAccessFlag[] = []
  if (access.shell) {
    flags.push('shell')
  }
  if (access.effective === 'files') {
    flags.push('files')
  } else if (access.effective === 'assets') {
    flags.push('assets')
  }
  return flags
}

/**
 * The flags a set of scenes shows (a template, a store version, a frame's
 * scenes.json), in display order: shell, files, assets. "reads all files"
 * replaces "reads assets folder" when any scene in the set reaches that far.
 */
export function sceneAccessFlags(scenes: unknown): SceneAccessFlag[] {
  const found = new Set<SceneAccessFlag>()
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    for (const flag of sceneAccessFlagsForScene(scene)) {
      found.add(flag)
    }
  }
  if (found.has('files')) {
    found.delete('assets')
  }
  return SCENE_ACCESS_FLAGS.filter((flag) => found.has(flag))
}

/** Known flags only, in display order: for catalogs that serve them as strings. */
export function knownSceneAccessFlags(flags: readonly string[] | null | undefined): SceneAccessFlag[] {
  const found = new Set(flags ?? [])
  const known = SCENE_ACCESS_FLAGS.filter((flag) => found.has(flag))
  return known.includes('files') ? known.filter((flag) => flag !== 'assets') : known
}

/**
 * A template's flags: from its scenes when it carries them (a saved template,
 * a scene list), otherwise the catalog's (a store or repository entry, whose
 * scenes are fetched only on install).
 */
export function templateAccessFlags(template: {
  flags?: readonly string[] | undefined
  scenes?: readonly unknown[] | undefined
}): SceneAccessFlag[] {
  return template.scenes && template.scenes.length > 0
    ? sceneAccessFlags(template.scenes)
    : knownSceneAccessFlags(template.flags)
}

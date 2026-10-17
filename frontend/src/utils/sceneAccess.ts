/**
 * What a scene reaches for on the frame, read from the scene's own JSON: the
 * asset access it declares (`settings.assetAccess`), what its content uses,
 * and the flags every surface shows next to its name ("runs shell commands",
 * "reads all files", "reads assets folder", "writes assets folder"). Content,
 * not provenance: the
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

/**
 * Reading and writing are separate flags: a write only ever lands inside the
 * assets folder (the asset calls refuse anything else), while Local Image only
 * reads, anywhere under "all-files". So "reads all files" covers "reads assets
 * folder" but never "writes assets folder".
 */
export type SceneAccessFlag = 'shell' | 'files' | 'assets' | 'assets-write'
export const SCENE_ACCESS_FLAGS: readonly SceneAccessFlag[] = ['shell', 'files', 'assets', 'assets-write']

export const sceneAccessFlagLabels: Record<SceneAccessFlag, string> = {
  shell: 'runs shell commands',
  files: 'reads all files',
  assets: 'reads assets folder',
  'assets-write': 'writes assets folder',
}

export const sceneAccessFlagDescriptions: Record<SceneAccessFlag, string> = {
  shell: 'This scene configures apps or code that run shell commands on the frame.',
  files: 'This scene can read any file on the frame, outside the assets folder too.',
  assets: "This scene reads the frame's assets folder: uploaded photos, fonts and what other scenes saved there.",
  'assets-write':
    "This scene writes and deletes files in the frame's assets folder, where your uploaded photos and other scenes' files are.",
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

// The `frameos` calls that reach the assets folder (frontend/src/utils/appTypeDeclarations.ts),
// split by what they do. `openAssetStream` is either, by its mode argument
// (assetStreamWrites). `fetchImage({saveAsset})` is none of them: that is the
// frame caching what it downloaded, not the scene using the folder.
const assetReadCallPattern = /\b(listAssets|assetExists|assetSize|readAsset|loadAssetImage)\b/
const assetWriteCallPattern = /\b(writeAsset|appendAsset|deleteAsset)\b/
const assetStreamPattern = /\bopenAssetStream\b/g
// A literal stream mode as it appears in the scene's JSON text: 'r', "r"
// (escaped to \"r\" inside a JSON string) or `r`.
const literalStreamModePattern = /^\\?(["'`])([rwa])\\?\1$/

/**
 * Whether the `openAssetStream(...)` call starting at `from` (just past the
 * name) opens for writing: mode "w" or "a", or a mode that is not a literal
 * this can read. No arguments or no mode is "r", the default. A mention that
 * is not a call (no parenthesis) reads.
 */
function assetStreamWrites(text: string, from: number): boolean {
  let index = from
  while (index < text.length && /\s/.test(text.charAt(index))) {
    index += 1
  }
  if (text.charAt(index) !== '(') {
    return false
  }
  let depth = 0
  const args: string[] = ['']
  for (index += 1; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) {
        break
      }
      depth -= 1
    } else if (char === ',' && depth === 0) {
      args.push('')
      continue
    }
    args[args.length - 1] += char
  }
  const mode = (args[1] ?? '').trim()
  if (mode === '') {
    return false
  }
  const literal = literalStreamModePattern.exec(mode)
  return !literal || literal[2] !== 'r'
}

const localImageKeywordPattern = /(^|\/)localImage$/

export interface SceneAccess {
  /** `settings.assetAccess`, "auto" when unset or not a known value. */
  declared: AssetAccess
  /** What the scene's content reaches for, whatever it declares. */
  detected: AssetReach
  /** The declared reach, or the detected one for "auto": what the flags show. */
  effective: AssetReach
  /** Why `detected` (and `writes`) is what it is, one short line per finding. */
  reasons: string[]
  shell: boolean
  /** The code writes or deletes assets (wherever the scene's root is). */
  writes: boolean
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
  let readCall = assetReadCallPattern.exec(text)?.[1] ?? null
  let writeCall = assetWriteCallPattern.exec(text)?.[1] ?? null
  for (const stream of text.matchAll(assetStreamPattern)) {
    if (assetStreamWrites(text, (stream.index ?? 0) + stream[0].length)) {
      writeCall = writeCall ?? 'openAssetStream to write'
    } else {
      readCall = readCall ?? 'openAssetStream'
    }
  }
  if (readCall || writeCall) {
    detected = wider(detected, 'assets')
  }
  if (readCall) {
    reasons.push(`its code calls frameos.${readCall}`)
  }
  if (writeCall) {
    reasons.push(`its code calls frameos.${writeCall}`)
  }

  const explicit = declaredReach[declared]
  return { declared, detected, effective: explicit ?? detected, reasons, shell, writes: writeCall !== null }
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

/**
 * The flags one scene shows; "reads all files" covers "reads assets folder".
 * Writing follows what the code does whatever is declared (the frame does
 * not enforce read-only), except under "cache-home-only", where the writes
 * land in the scene's own folder.
 */
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
  if (access.writes && (access.effective === 'assets' || access.effective === 'files')) {
    flags.push('assets-write')
  }
  return flags
}

/**
 * The flags a set of scenes shows (a template, a store version, a frame's
 * scenes.json), in display order: shell, files, assets, assets-write. "reads
 * all files" replaces "reads assets folder" when any scene in the set reaches
 * that far.
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

export interface SceneAccessChanges {
  /** What the scenes showed before, in display order. */
  before: SceneAccessFlag[]
  /** What they show after. */
  after: SceneAccessFlag[]
  /** What `after` may do that `before` could not: "reads assets folder" turning into "reads all files" gains `files`. */
  gained: SceneAccessFlag[]
  /** What `before` could do that `after` no longer does. */
  lost: SceneAccessFlag[]
}

// "reads all files" includes reading the assets folder, so a set showing
// `files` can do everything `assets` allows: compared with it spelled out.
function reachableFlags(flags: readonly SceneAccessFlag[]): Set<SceneAccessFlag> {
  const reachable = new Set(flags)
  if (reachable.has('files')) {
    reachable.add('assets')
  }
  return reachable
}

function displayFlags(flags: Set<SceneAccessFlag>): SceneAccessFlag[] {
  return SCENE_ACCESS_FLAGS.filter((flag) => flags.has(flag) && !(flag === 'assets' && flags.has('files')))
}

/** What changes between two flag lists (sceneAccessFlags or catalog flags). */
export function sceneAccessFlagChanges(
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined
): SceneAccessChanges {
  const beforeFlags = knownSceneAccessFlags(before)
  const afterFlags = knownSceneAccessFlags(after)
  const was = reachableFlags(beforeFlags)
  const now = reachableFlags(afterFlags)
  return {
    before: beforeFlags,
    after: afterFlags,
    gained: displayFlags(new Set([...now].filter((flag) => !was.has(flag)))),
    lost: displayFlags(new Set([...was].filter((flag) => !now.has(flag)))),
  }
}

/**
 * What changes when `before` is replaced by `after`: a scene or a set of
 * scenes each (an installed scene and its update, a template's scenes and the
 * new version's), read with the same detector.
 */
export function sceneAccessChanges(before: unknown, after: unknown): SceneAccessChanges {
  const flagsOf = (scenes: unknown): SceneAccessFlag[] =>
    Array.isArray(scenes) ? sceneAccessFlags(scenes) : sceneAccessFlagsForScene(scenes)
  return sceneAccessFlagChanges(flagsOf(before), flagsOf(after))
}

/** The flags that reach past the frame's own data: worth a red button when gained. */
export function accessChangesAreRisky(changes: SceneAccessChanges): boolean {
  return changes.gained.some((flag) => flag === 'shell' || flag === 'files' || flag === 'assets-write')
}

/**
 * The gained flags as one phrase, e.g. "reads all files (was reads assets
 * folder), writes assets folder". "" when nothing was gained.
 */
export function describeGainedAccess(changes: SceneAccessChanges): string {
  return changes.gained
    .map((flag) =>
      flag === 'files' && changes.before.includes('assets')
        ? `${sceneAccessFlagLabels.files} (was ${sceneAccessFlagLabels.assets})`
        : sceneAccessFlagLabels[flag]
    )
    .join(', ')
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

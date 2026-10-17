/**
 * What a scene may do on the frame, read from its own JSON. Permissions
 * belong to APPS: each app asks for them in its config.json
 * (`"permissions": ["assets", ...]`), and a scene may do what its apps ask
 * for, nothing more. Code nodes cannot touch files and ask for nothing. The
 * API keys an app reads (its config.json `"settings"`) show the same way.
 * Every surface shows the union as tags ("runs shell commands", "reads all
 * files", "reads assets folder", "writes assets folder", "uses OpenAI key"),
 * and installing a scene that shows them is the approval.
 *
 * A JavaScript app's list is filled from its code whenever the scene is saved
 * (`withAppPermissions`) unless its config.json says `"permissionsAuto":
 * false`: then the list is the author's and is left as written. The frame
 * gives each JS app exactly what its list asks for (frameos/src/frameos/
 * js_runtime/app_runtime.nim), and an app with no list nothing. Scenes stored
 * before the lists existed got theirs from the control planes: the backend's
 * migration 5e2a9c71d4b8 (a frozen Python copy of this detection) and the
 * cloud's read-time stamp. Built-in apps are FrameOS's own code and
 * declare theirs in frameos/src/apps (BUILTIN_APP_ACCESS mirrors them).
 *
 * One implementation for the SPA (both control planes), the cloud store's
 * publish-time `risk_flags` and the cloud's read-time stamp of scenes that
 * predate the lists (cloud/apps/auth-web/src/lib/store.ts, scene-origin.ts).
 * docs/scene-access-fixtures.json is the corpus it is tested against.
 *
 * Plain TypeScript on unknown input, no imports: the cloud server compiles it
 * under its stricter tsconfig.
 */

/** What an app may ask for. A write only ever lands inside the assets folder, so "files" covers reading the assets folder but never writing it. */
export type ScenePermission = 'shell' | 'files' | 'assets' | 'assets-write'
export const SCENE_PERMISSIONS: readonly ScenePermission[] = ['shell', 'files', 'assets', 'assets-write']

/** "Uses your <service> key": a settings namespace an app reads with getSetting. */
export type SceneKeyFlag = `key:${string}`
export type SceneAccessFlag = ScenePermission | SceneKeyFlag

const permissionLabels: Record<ScenePermission, string> = {
  shell: 'runs shell commands',
  files: 'reads all files',
  assets: 'reads assets folder',
  'assets-write': 'writes assets folder',
}

const permissionDescriptions: Record<ScenePermission, string> = {
  shell: 'This scene uses apps that run shell commands on the frame.',
  files: 'This scene can read any file on the frame, outside the assets folder too.',
  assets: "This scene reads the frame's assets folder: uploaded photos, fonts and what other scenes saved there.",
  'assets-write':
    "This scene writes and deletes files in the frame's assets folder, where your uploaded photos and other scenes' files are.",
}

/** The services behind the settings namespaces apps declare (secretSettings.ts takes its titles from here). */
export const SETTINGS_KEY_TITLES: Readonly<Record<string, string>> = {
  openAI: 'OpenAI',
  unsplash: 'Unsplash',
  homeAssistant: 'Home Assistant',
  immich: 'Immich',
  github: 'GitHub',
  frameOS: 'FrameOS Gallery',
}

export function settingsKeyTitle(namespace: string): string {
  return SETTINGS_KEY_TITLES[namespace] ?? namespace
}

const keyNamespacePattern = /^[A-Za-z][A-Za-z0-9_]{0,40}$/

export function isScenePermission(value: unknown): value is ScenePermission {
  return typeof value === 'string' && (SCENE_PERMISSIONS as readonly string[]).includes(value)
}

/** The namespace of a `key:<namespace>` flag, or null when `flag` is not one. */
export function keyFlagNamespace(flag: string): string | null {
  if (!flag.startsWith('key:')) {
    return null
  }
  const namespace = flag.slice(4)
  return keyNamespacePattern.test(namespace) ? namespace : null
}

export function sceneAccessFlagLabel(flag: SceneAccessFlag): string {
  const namespace = keyFlagNamespace(flag)
  return namespace !== null ? `uses ${settingsKeyTitle(namespace)} key` : permissionLabels[flag as ScenePermission]
}

export function sceneAccessFlagDescription(flag: SceneAccessFlag): string {
  const namespace = keyFlagNamespace(flag)
  return namespace !== null
    ? `This scene's apps read your ${settingsKeyTitle(namespace)} key from the frame's settings.`
    : permissionDescriptions[flag as ScenePermission]
}

/** The permissions that reach past the frame's own data: red tags, and a red button when an update gains one. */
export function sceneAccessFlagIsRisky(flag: SceneAccessFlag): boolean {
  return flag === 'shell' || flag === 'files' || flag === 'assets-write'
}

/**
 * What the built-in (Nim) apps declare in their config.json under
 * frameos/src/apps: kept here rather than imported because the cloud server
 * compiles this file on its own. scene-access.test.ts checks it against every
 * config.json, `permissions` and `settings` alike.
 */
export const BUILTIN_APP_ACCESS: Readonly<
  Record<string, { permissions?: readonly ScenePermission[]; settings?: readonly string[] }>
> = {
  'data/chromiumScreenshot': { permissions: ['shell'] },
  'data/localImage': { permissions: ['files'] },
  'data/rstpSnapshot': { permissions: ['shell'] },
}

/** A built-in app by keyword: `data/localImage`, or the bare `localImage` older scenes carry. */
function builtinAppKeyword(keyword: string): string | null {
  if (BUILTIN_APP_ACCESS[keyword]) {
    return keyword
  }
  if (keyword.includes('/')) {
    return null
  }
  return Object.keys(BUILTIN_APP_ACCESS).find((key) => key.endsWith(`/${keyword}`)) ?? null
}

// The process APIs a legacy compiled scene (Nim code nodes, Nim app sources)
// can call. JavaScript cannot spawn processes, so only Nim is looked at.
const nimShellPattern =
  /\b(execShellCmd|execCmdEx|execCmd|execProcess|startProcess|runShellWithParentStreams|runShellCapture|osproc|quoteShell)\b/

// The `frameos` calls that reach the assets folder (frontend/src/utils/appTypeDeclarations.ts),
// split by what they do. `openAssetStream` is either, by its mode argument
// (assetStreamWrites). `fetchImage({saveAsset})` is none of them: that is the
// frame caching what it downloaded, not the app using the folder.
const assetReadCallPattern = /\b(listAssets|assetExists|assetSize|readAsset|loadAssetImage)\b/
const assetWriteCallPattern = /\b(writeAsset|appendAsset|deleteAsset)\b/
const assetStreamPattern = /\bopenAssetStream\b/g
// A literal stream mode: 'r', "r" or `r` (escaped to \"r\" inside JSON text).
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const javascriptSourcePattern = /\.(tsx?|jsx?|mjs|cjs)$/

function stringSources(value: unknown): Record<string, string> | null {
  const sources = record(value)
  if (!sources) {
    return null
  }
  const strings: Record<string, string> = {}
  for (const [name, text] of Object.entries(sources)) {
    if (typeof text === 'string') {
      strings[name] = text
    }
  }
  return strings
}

/** A JavaScript app (app.ts, app.js, ...): the only kind whose list the frame enforces. */
function hasJavaScriptSource(sources: Record<string, string> | null): sources is Record<string, string> {
  return !!sources && ['app.ts', 'app.js', 'app.tsx', 'app.jsx'].some((file) => !!sources[file]?.trim())
}

/** A legacy compiled (Nim) app the scene carries: looked at for process APIs only. */
function hasNimSource(sources: Record<string, string> | null): sources is Record<string, string> {
  return !!sources && Object.keys(sources).some((name) => name.endsWith('.nim'))
}

function parseConfig(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) {
    return null
  }
  try {
    return record(JSON.parse(text))
  } catch {
    return null
  }
}

/** Known names only, in SCENE_PERMISSIONS order. */
function orderedPermissions(values: Iterable<unknown>): ScenePermission[] {
  const found = new Set<unknown>(values)
  return SCENE_PERMISSIONS.filter((permission) => found.has(permission))
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

interface SourceDetection {
  detected: ScenePermission[]
  reasons: string[]
}

// Detection depends on an app's files only, and sanitizing a scene runs it on
// every edit: remembered per sources object (state is immutable, an edit
// replaces the object).
const detectionCache = new WeakMap<object, SourceDetection>()

/** What an app's own files reach for: asset calls in its JavaScript, process APIs in a legacy Nim app. */
function detectSources(sources: Record<string, string>, cacheKey: object | null): SourceDetection {
  const cached = cacheKey ? detectionCache.get(cacheKey) : undefined
  if (cached) {
    return cached
  }
  let readCall: string | null = null
  let writeCall: string | null = null
  let shell = false
  for (const [name, text] of Object.entries(sources)) {
    if (name.endsWith('.nim')) {
      shell = shell || nimShellPattern.test(text)
      continue
    }
    if (!javascriptSourcePattern.test(name)) {
      continue
    }
    readCall = readCall ?? assetReadCallPattern.exec(text)?.[1] ?? null
    writeCall = writeCall ?? assetWriteCallPattern.exec(text)?.[1] ?? null
    for (const stream of text.matchAll(assetStreamPattern)) {
      if (assetStreamWrites(text, (stream.index ?? 0) + stream[0].length)) {
        writeCall = writeCall ?? 'openAssetStream to write'
      } else {
        readCall = readCall ?? 'openAssetStream'
      }
    }
  }
  const found: ScenePermission[] = []
  const reasons: string[] = []
  if (shell) {
    found.push('shell')
    reasons.push('its Nim code runs processes')
  }
  if (readCall || writeCall) {
    found.push('assets')
  }
  if (readCall) {
    reasons.push(`calls frameos.${readCall}`)
  }
  if (writeCall) {
    found.push('assets-write')
    reasons.push(`calls frameos.${writeCall}`)
  }
  const detection = { detected: orderedPermissions(found), reasons }
  if (cacheKey) {
    detectionCache.set(cacheKey, detection)
  }
  return detection
}

export interface AppAccess {
  /** The node's keyword (the scene.apps key for a scene app). */
  keyword: string
  /** How the settings panel names it. */
  name: string
  /** A built-in app (declared in frameos/src/apps) or one whose files the scene carries. */
  kind: 'builtin' | 'scene'
  /** Its config.json `permissions`, known names in order; null when it has no list yet (the next save writes one). */
  declared: ScenePermission[] | null
  /** False when config.json says `"permissionsAuto": false`: the list is the author's and saving leaves it alone. */
  auto: boolean
  /** What its code reaches for (for a built-in app, what it declares). */
  detected: ScenePermission[]
  /** What it may do: the declared list, or what was detected when there is none. */
  permissions: ScenePermission[]
  /** Its config.json `settings`: the API keys it reads. */
  settings: string[]
  /** Why `detected` is what it is, one short phrase per finding. */
  reasons: string[]
}

export interface SceneAccess {
  /** Every app the scene's nodes run, once per app. */
  apps: AppAccess[]
  /** A legacy Nim code node calls a process API. */
  legacyShell: boolean
  /** The union, in display order: permissions, then keys. */
  flags: SceneAccessFlag[]
}

function sceneAppAccess(
  keyword: string,
  sources: Record<string, string>,
  cacheKey: object | null,
  fallback: Record<string, unknown> | null
): AppAccess {
  const config = parseConfig(sources['config.json'])
  const listed = config?.['permissions']
  const declared = Array.isArray(listed) ? orderedPermissions(listed) : null
  const { detected, reasons } = detectSources(sources, cacheKey)
  const name = config?.['name'] ?? fallback?.['name']
  return {
    keyword,
    name: typeof name === 'string' && name.trim() ? name.trim() : keyword,
    kind: 'scene',
    declared,
    auto: config?.['permissionsAuto'] !== false,
    detected,
    permissions: declared ?? detected,
    settings: stringList(config ? config['settings'] : fallback?.['settings']),
    reasons,
  }
}

function builtinAccess(keyword: string, builtin: string): AppAccess {
  const entry = BUILTIN_APP_ACCESS[builtin] ?? {}
  const permissions = orderedPermissions(entry.permissions ?? [])
  return {
    keyword,
    name: builtin.slice(builtin.lastIndexOf('/') + 1),
    kind: 'builtin',
    declared: permissions,
    auto: false,
    detected: permissions,
    permissions,
    settings: [...(entry.settings ?? [])],
    reasons: [],
  }
}

function sortedKeyFlags(namespaces: Iterable<string>): SceneKeyFlag[] {
  return [...new Set(namespaces)]
    .filter((namespace) => keyNamespacePattern.test(namespace))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((namespace) => `key:${namespace}` as SceneKeyFlag)
}

/** Display order: permissions (`files` replacing `assets`), then keys by name. */
function displayOrder(permissions: Iterable<ScenePermission>, namespaces: Iterable<string>): SceneAccessFlag[] {
  const found = new Set(permissions)
  if (found.has('files')) {
    found.delete('assets')
  }
  return [...SCENE_PERMISSIONS.filter((permission) => found.has(permission)), ...sortedKeyFlags(namespaces)]
}

/**
 * The apps a scene runs and what each may do, picked the way the frame picks
 * an app for a node: the node's own sources, else the scene's app of that
 * keyword, else the built-in app.
 */
export function sceneAccess(scene: unknown): SceneAccess {
  const sceneRecord = record(scene)
  const nodes = Array.isArray(sceneRecord?.['nodes']) ? (sceneRecord?.['nodes'] as unknown[]) : []
  const sceneApps = record(sceneRecord?.['apps'])
  const apps: AppAccess[] = []
  const seen = new Set<unknown>()
  let legacyShell = false
  for (const node of nodes) {
    const nodeRecord = record(node)
    const data = record(nodeRecord?.['data'])
    // Legacy Nim code (`code` with no `codeJS`), whatever the node calls
    // itself: compiled Nim can run processes. JavaScript code cannot.
    const code = data?.['code']
    const codeJS = data?.['codeJS']
    if (typeof code === 'string' && !(typeof codeJS === 'string' && codeJS.trim()) && nimShellPattern.test(code)) {
      legacyShell = true
    }
    if (nodeRecord?.['type'] === 'code') {
      continue
    }
    const keyword = data?.['keyword']
    if (nodeRecord?.['type'] !== 'app' || typeof keyword !== 'string' || !keyword) {
      continue
    }
    const nodeSources = stringSources(data?.['sources'])
    if (hasJavaScriptSource(nodeSources) || hasNimSource(nodeSources)) {
      if (!seen.has(data?.['sources'])) {
        seen.add(data?.['sources'])
        apps.push(sceneAppAccess(keyword, nodeSources, record(data?.['sources']), null))
      }
      continue
    }
    const sceneApp = record(sceneApps?.[keyword])
    const appSources = stringSources(sceneApp?.['sources'])
    if (hasJavaScriptSource(appSources) || hasNimSource(appSources)) {
      if (!seen.has(sceneApp)) {
        seen.add(sceneApp)
        apps.push(sceneAppAccess(keyword, appSources, record(sceneApp?.['sources']), sceneApp))
      }
      continue
    }
    const builtin = builtinAppKeyword(keyword)
    if (builtin && !seen.has(builtin)) {
      seen.add(builtin)
      apps.push(builtinAccess(keyword, builtin))
    }
  }
  const permissions = apps.flatMap((app) => app.permissions)
  if (legacyShell) {
    permissions.push('shell')
  }
  return {
    apps,
    legacyShell,
    flags: displayOrder(
      permissions,
      apps.flatMap((app) => app.settings)
    ),
  }
}

/** The tags one scene shows. */
export function sceneAccessFlagsForScene(scene: unknown): SceneAccessFlag[] {
  return sceneAccess(scene).flags
}

/** The tags a set of scenes shows (a template, a store version, a frame's scenes.json). */
export function sceneAccessFlags(scenes: unknown): SceneAccessFlag[] {
  return knownSceneAccessFlags(
    (Array.isArray(scenes) ? scenes : []).flatMap((scene) => sceneAccessFlagsForScene(scene))
  )
}

/** Known flags only, in display order: for catalogs that serve them as strings. */
export function knownSceneAccessFlags(flags: readonly string[] | null | undefined): SceneAccessFlag[] {
  const list = flags ?? []
  return displayOrder(
    list.filter(isScenePermission),
    list.map((flag) => keyFlagNamespace(flag)).filter((namespace): namespace is string => namespace !== null)
  )
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

/**
 * What an app's code reaches for beyond what its list asks for: the calls
 * the frame refuses. Empty for an app with no list yet (saving, or the
 * cloud's read-time stamp, gives it what its code calls for) or one whose
 * list covers its code. `files` covers a read of the assets folder.
 */
export function appPermissionShortfall(app: AppAccess): ScenePermission[] {
  if (app.declared === null) {
    return []
  }
  const granted = new Set(app.declared)
  if (granted.has('files')) {
    granted.add('assets')
  }
  return app.detected.filter((permission) => !granted.has(permission))
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
function reachable(flags: readonly SceneAccessFlag[]): Set<SceneAccessFlag> {
  const set = new Set(flags)
  if (set.has('files')) {
    set.add('assets')
  }
  return set
}

function difference(from: Set<SceneAccessFlag>, without: Set<SceneAccessFlag>): SceneAccessFlag[] {
  return knownSceneAccessFlags([...from].filter((flag) => !without.has(flag)))
}

/** What changes between two flag lists (sceneAccessFlags or catalog flags). */
export function sceneAccessFlagChanges(
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined
): SceneAccessChanges {
  const beforeFlags = knownSceneAccessFlags(before)
  const afterFlags = knownSceneAccessFlags(after)
  const was = reachable(beforeFlags)
  const now = reachable(afterFlags)
  return { before: beforeFlags, after: afterFlags, gained: difference(now, was), lost: difference(was, now) }
}

/**
 * What changes when `before` is replaced by `after`: a scene or a set of
 * scenes each (an installed scene and its update, a template's scenes and the
 * new version's), read the same way.
 */
export function sceneAccessChanges(before: unknown, after: unknown): SceneAccessChanges {
  const flagsOf = (scenes: unknown): SceneAccessFlag[] =>
    Array.isArray(scenes) ? sceneAccessFlags(scenes) : sceneAccessFlagsForScene(scenes)
  return sceneAccessFlagChanges(flagsOf(before), flagsOf(after))
}

/** Gaining any of these is worth a red button. */
export function accessChangesAreRisky(changes: SceneAccessChanges): boolean {
  return changes.gained.some(sceneAccessFlagIsRisky)
}

/**
 * The gained flags as one phrase, e.g. "reads all files (was reads assets
 * folder), uses OpenAI key". "" when nothing was gained.
 */
export function describeGainedAccess(changes: SceneAccessChanges): string {
  return changes.gained
    .map((flag) =>
      flag === 'files' && changes.before.includes('assets')
        ? `${sceneAccessFlagLabel('files')} (was ${sceneAccessFlagLabel('assets')})`
        : sceneAccessFlagLabel(flag)
    )
    .join(', ')
}

/**
 * config.json with `permissions` set to `permissions`, or null when it stays
 * as it is: already that list, a list the author set by hand
 * (`"permissionsAuto": false`), any list at all when `onlyMissing`, or a file
 * that does not parse (left for its author to fix). Other keys keep their
 * order; a new `permissions` goes after `settings`, or last. The file keeps
 * its indent and trailing newline; an app with no config.json gets one.
 */
function configWithPermissions(
  text: string | undefined,
  permissions: ScenePermission[],
  onlyMissing: boolean
): string | null {
  if (text === undefined) {
    return `${JSON.stringify({ permissions }, null, 2)}\n`
  }
  const config = parseConfig(text)
  if (!config || config['permissionsAuto'] === false) {
    return null
  }
  const current = config['permissions']
  if (current !== undefined && onlyMissing) {
    return null
  }
  if (
    Array.isArray(current) &&
    current.length === permissions.length &&
    current.every((value, index) => value === permissions[index])
  ) {
    return null
  }
  const entries = Object.entries(config)
  const at = entries.findIndex(([key]) => key === 'permissions')
  if (at >= 0) {
    entries[at] = ['permissions', permissions]
  } else {
    const settingsAt = entries.findIndex(([key]) => key === 'settings')
    entries.splice(settingsAt >= 0 ? settingsAt + 1 : entries.length, 0, ['permissions', permissions])
  }
  const indent = /\n( +)"/.exec(text)?.[1]?.length ?? 2
  return `${JSON.stringify(Object.fromEntries(entries), null, indent)}${text.endsWith('\n') ? '\n' : ''}`
}

function withSourcesPermissions(sources: unknown, onlyMissing: boolean): Record<string, unknown> | null {
  const strings = stringSources(sources)
  if (!hasJavaScriptSource(strings)) {
    return null
  }
  const { detected } = detectSources(strings, record(sources))
  const next = configWithPermissions(strings['config.json'], detected, onlyMissing)
  return next === null ? null : { ...(record(sources) ?? {}), 'config.json': next }
}

/**
 * The scene with every JavaScript app's config.json `permissions` set from
 * its code, the way a save leaves it: apps whose list the author set by hand
 * (`"permissionsAuto": false`) and files that do not parse are left alone.
 * With `onlyMissing`, only apps with no list at all get one (the cloud's
 * read-time stamp of scenes that predate the lists). Returns the same object
 * when nothing changes.
 */
export function withAppPermissions<T>(scene: T, options: { onlyMissing?: boolean } = {}): T {
  const sceneRecord = record(scene)
  if (!sceneRecord) {
    return scene
  }
  const onlyMissing = options.onlyMissing === true
  const apps = record(sceneRecord['apps'])
  let nextApps: Record<string, unknown> | null = null
  for (const [keyword, app] of Object.entries(apps ?? {})) {
    const appRecord = record(app)
    const sources = withSourcesPermissions(appRecord?.['sources'], onlyMissing)
    if (appRecord && sources) {
      nextApps = nextApps ?? { ...apps }
      nextApps[keyword] = { ...appRecord, sources }
    }
  }
  const nodes = Array.isArray(sceneRecord['nodes']) ? (sceneRecord['nodes'] as unknown[]) : []
  let nextNodes: unknown[] | null = null
  for (let index = 0; index < nodes.length; index += 1) {
    const nodeRecord = record(nodes[index])
    const data = record(nodeRecord?.['data'])
    const sources = nodeRecord?.['type'] === 'app' && data ? withSourcesPermissions(data['sources'], onlyMissing) : null
    if (nodeRecord && data && sources) {
      nextNodes = nextNodes ?? [...nodes]
      nextNodes[index] = { ...nodeRecord, data: { ...data, sources } }
    }
  }
  if (!nextApps && !nextNodes) {
    return scene
  }
  return {
    ...sceneRecord,
    ...(nextApps ? { apps: nextApps } : {}),
    ...(nextNodes ? { nodes: nextNodes } : {}),
  } as T
}

/** `withAppPermissions` over a scenes.json array. */
export function withScenesAppPermissions<T>(scenes: readonly T[], options: { onlyMissing?: boolean } = {}): T[] {
  return scenes.map((scene) => withAppPermissions(scene, options))
}

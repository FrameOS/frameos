/**
 * What a scene may do on the frame, read from its own JSON. Permissions
 * belong to APPS: each app asks for them in its config.json
 * (`"permissions": ["assets", ...]`), and a scene may do what its apps ask
 * for, nothing more. Code nodes cannot touch files and ask for nothing. The
 * API keys an app reads (its config.json `"settings"`) show the same way.
 * Every surface shows the union as tags ("runs shell commands", "reads all
 * files", "reads files", "writes files" or the two as "reads & writes files",
 * "changes frame settings", "uses OpenAI key": `sceneAccessTags`), and
 * installing a scene that shows them is the approval. "Files" are the
 * frame's assets folder; "all files" anything on the frame.
 *
 * config.json is read one way by everyone who decides on it
 * (`parseAppConfig`, docs/app-config-fixtures.json): strict JSON, an object.
 * The frame gives an app whose file is anything else nothing, a save or a
 * publish of one is refused (`sceneAppConfigProblem`), and one already
 * stored shows as asking for everything a JavaScript app can be given, never
 * as asking for nothing.
 *
 * A JavaScript app's list is set from its code whenever the scene is saved
 * (`withAppPermissions`), so it follows the code. The frame gives each JS app
 * exactly what its list asks for (frameos/src/frameos/
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
 * Plain TypeScript on unknown input, importing only the generated services
 * registry (data): the cloud server compiles it under its stricter tsconfig.
 */
import { SERVICE_REGISTRY } from '../generated/services.gen'

/**
 * What an app may ask for. A write only ever lands inside the assets folder, so "files" covers reading the assets folder
 * but never writing it. "frame" is `frameos.frame`: the frame page's facts and powers (Wi-Fi, rotation, scale, render,
 * restart, reboot) and an ESP32's serial console, while the frame page is allowed on the screen (docs/terminal.md).
 * "code" is `frameos.code`: every scene's source on the frame, saving scenes to it and asking its control plane's AI
 * for one, under the same condition (docs/code-editor.md). "store" is `frameos.storeAction`: installing, previewing,
 * updating and removing scenes on the frame and choosing its layout, as the Scene store does (docs/scene-store.md).
 */
export type ScenePermission = 'shell' | 'files' | 'assets' | 'assets-write' | 'frame' | 'code' | 'store'
export const SCENE_PERMISSIONS: readonly ScenePermission[] = [
  'shell',
  'files',
  'assets',
  'assets-write',
  'frame',
  'code',
  'store',
]

/** "Uses your <service> key": a settings namespace an app reads with getSetting. */
export type SceneKeyFlag = `key:${string}`
export type SceneAccessFlag = ScenePermission | SceneKeyFlag

const permissionLabels: Record<ScenePermission, string> = {
  shell: 'runs shell commands',
  files: 'reads all files',
  assets: 'reads files',
  'assets-write': 'writes files',
  frame: 'changes frame settings',
  code: "reads and changes this frame's scenes",
  store: 'installs and removes scenes',
}

const permissionDescriptions: Record<ScenePermission, string> = {
  shell: 'This scene uses apps that run shell commands on the frame.',
  files: 'This scene can read any file on the frame, outside the assets folder too.',
  assets: "This scene reads the frame's assets folder: uploaded photos, fonts and what other scenes saved there.",
  'assets-write':
    "This scene writes and deletes files in the frame's assets folder, where your uploaded photos and other scenes' files are.",
  frame:
    "This scene can change the frame's Wi-Fi, rotation and scale, restart or reboot it, and run its console commands on an ESP32, as the frame's settings on its screen can.",
  code: "This scene can read the code and the settings of every scene on the frame (API keys set in their apps included), change them and add scenes, and ask the frame's control plane's AI to write scenes.",
  store:
    "This scene can install, preview, update and remove scenes from the scene store on the frame, and choose the frame's layout, as the Scene store does.",
}

/** The titles of the services the registry knows (repo/services.json, docs/service-keys.md). */
export const SETTINGS_KEY_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SERVICE_REGISTRY).map(([id, service]) => [id, service.title])
)

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

/** One tag a surface shows for a scene's access: a flag, or reading and writing files as one. */
export interface SceneAccessTag {
  key: string
  label: string
  description: string
  /** Red: reaches past the scene's own reading of your photos (sceneAccessFlagIsRisky). */
  risky: boolean
  /** The flags the tag stands for. */
  flags: SceneAccessFlag[]
}

/**
 * The tags for a scene's flags, as every surface draws them: reading and
 * writing the assets folder become one "reads & writes files", and reading it
 * is left out where the scene reads all files anyway.
 */
export function sceneAccessTags(flags: readonly SceneAccessFlag[]): SceneAccessTag[] {
  const has = new Set(flags)
  const tags: SceneAccessTag[] = []
  for (const flag of flags) {
    if (flag === 'assets' && has.has('files')) {
      continue
    }
    if (flag === 'assets' && has.has('assets-write')) {
      continue
    }
    if (flag === 'assets-write' && has.has('assets') && !has.has('files')) {
      tags.push({
        key: 'assets+write',
        label: 'reads & writes files',
        description:
          "This scene reads, writes and deletes files in the frame's assets folder, where your uploaded photos and other scenes' files are.",
        risky: true,
        flags: ['assets', 'assets-write'],
      })
      continue
    }
    tags.push({
      key: flag,
      label: sceneAccessFlagLabel(flag),
      description: sceneAccessFlagDescription(flag),
      risky: sceneAccessFlagIsRisky(flag),
      flags: [flag],
    })
  }
  return tags
}

/** The permissions that reach past the frame's own data: red tags, and a red button when an update gains one. */
export function sceneAccessFlagIsRisky(flag: SceneAccessFlag): boolean {
  return (
    flag === 'shell' ||
    flag === 'files' ||
    flag === 'assets-write' ||
    flag === 'frame' ||
    flag === 'code' ||
    flag === 'store'
  )
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
const assetWriteCallPattern = /\b(writeAsset|appendAsset|deleteAsset|makeAssetFolder)\b/
const assetStreamPattern = /\bopenAssetStream\b/g
// A literal stream mode: 'r', "r" or `r` (escaped to \"r\" inside JSON text).
// `frameos.frame(...)`: the frame page's powers. Named with its object, as a
// bare `frame` is any word.
const frameCallPattern = /\bframeos\s*\.\s*frame\s*\(/
// `frameos.code(...)`: the frame's scenes and its plane's scene AI.
const codeCallPattern = /\bframeos\s*\.\s*code\s*\(/
// `frameos.storeAction(...)`: the scenes on the frame and its layout.
const storeCallPattern = /\bframeos\s*\.\s*storeAction\s*\(/
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

/** How deep an app's config.json may nest: every reader's limit (docs/app-config-fixtures.json). */
export const APP_CONFIG_MAX_DEPTH = 32

function withinDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') {
    return true
  }
  if (depth <= 0) {
    return false
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    if (!withinDepth(item, depth - 1)) {
      return false
    }
  }
  return true
}

/**
 * An app's config.json as every reader takes it, or null when it is not one: strict JSON (`JSON.parse`), an
 * object, at most APP_CONFIG_MAX_DEPTH containers deep. The frame's runtime reads exactly this
 * (frameos/src/frameos/utils/strict_json.nim) and the backend too (app/utils/app_config.py);
 * docs/app-config-fixtures.json is the corpus all three replay. A file that is not one asks for nothing on the
 * frame, so no surface may read permissions or settings out of it some other way.
 */
export function parseAppConfig(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const config = record(parsed)
  return config && withinDepth(config, APP_CONFIG_MAX_DEPTH) ? config : null
}

function parseConfig(text: string | undefined): Record<string, unknown> | null {
  return parseAppConfig(text)
}

/**
 * What an app whose config.json cannot be read is shown as asking for: everything a JavaScript app can be given.
 * A frame from before the strict reader read such a file leniently, so it may hold any of them.
 */
const UNREADABLE_CONFIG_PERMISSIONS: readonly ScenePermission[] = ['assets', 'assets-write', 'frame', 'code', 'store']

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

/** What an app's own files reach for: asset and frame calls in its JavaScript, process APIs in a legacy Nim app. */
function detectSources(sources: Record<string, string>, cacheKey: object | null): SourceDetection {
  const cached = cacheKey ? detectionCache.get(cacheKey) : undefined
  if (cached) {
    return cached
  }
  let readCall: string | null = null
  let writeCall: string | null = null
  let shell = false
  let frame = false
  let codeCall = false
  let storeCall = false
  for (const [name, text] of Object.entries(sources)) {
    if (name.endsWith('.nim')) {
      shell = shell || nimShellPattern.test(text)
      continue
    }
    if (!javascriptSourcePattern.test(name)) {
      continue
    }
    frame = frame || frameCallPattern.test(text)
    codeCall = codeCall || codeCallPattern.test(text)
    storeCall = storeCall || storeCallPattern.test(text)
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
  if (frame) {
    found.push('frame')
    reasons.push('calls frameos.frame')
  }
  if (codeCall) {
    found.push('code')
    reasons.push('calls frameos.code')
  }
  if (storeCall) {
    found.push('store')
    reasons.push('calls frameos.storeAction')
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
  /** What its code reaches for (for a built-in app, what it declares). */
  detected: ScenePermission[]
  /** What it may do: the declared list, or what was detected when there is none. */
  permissions: ScenePermission[]
  /** Its config.json `settings`: the API keys it reads. */
  settings: string[]
  /** Why `detected` is what it is, one short phrase per finding. */
  reasons: string[]
  /**
   * It carries a config.json that is not one (parseAppConfig): what it asks for cannot be read, so it shows as
   * asking for everything a JavaScript app can be given, and no control plane saves or publishes it.
   */
  unreadable?: true
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
  // A config.json that is there and is not one: nothing can be read from it, and "asks for nothing" is the one
  // thing it must not be taken to say (only a JavaScript app is given anything by its list).
  const unreadable = sources['config.json'] !== undefined && config === null && hasJavaScriptSource(sources)
  return {
    keyword,
    name: typeof name === 'string' && name.trim() ? name.trim() : keyword,
    kind: 'scene',
    declared,
    detected,
    permissions: unreadable
      ? orderedPermissions([...UNREADABLE_CONFIG_PERMISSIONS, ...detected])
      : (declared ?? detected),
    settings: stringList(config ? config['settings'] : fallback?.['settings']),
    reasons: unreadable ? ['its config.json is not valid JSON', ...reasons] : reasons,
    ...(unreadable ? { unreadable: true as const } : {}),
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

/**
 * What is wrong with a scene's apps' config.json files, in words, or null: the first JavaScript app (one of the
 * scene's, or a node's own files, run by a node or not) whose config.json is not strict JSON and an object. Every
 * door a scene is saved, published or imported through refuses such a scene on both control planes (the backend's
 * app/utils/app_config.py says the same): the frame gives that app nothing, and no surface can show what it asks.
 */
export function sceneAppConfigProblem(scene: unknown): string | null {
  const sceneRecord = record(scene)
  if (!sceneRecord) {
    return null
  }
  const named = (keyword: string): string => {
    const sceneName = sceneRecord['name'] ?? sceneRecord['id']
    return `App "${keyword}"${
      typeof sceneName === 'string' && sceneName ? ` in scene "${sceneName}"` : ''
    }: config.json is not valid JSON. Fix the file (no comments, no trailing commas) and save again.`
  }
  const broken = (sources: unknown): boolean => {
    const files = record(sources)
    return !!files && files['config.json'] !== undefined && parseAppConfig(files['config.json']) === null
  }
  for (const [keyword, app] of Object.entries(record(sceneRecord['apps']) ?? {})) {
    if (broken(record(app)?.['sources'])) {
      return named(keyword)
    }
  }
  for (const node of Array.isArray(sceneRecord['nodes']) ? (sceneRecord['nodes'] as unknown[]) : []) {
    const nodeRecord = record(node)
    const data = record(nodeRecord?.['data'])
    if (nodeRecord?.['type'] === 'app' && broken(data?.['sources'])) {
      const keyword = data?.['keyword']
      return named(typeof keyword === 'string' && keyword ? keyword : String(nodeRecord?.['id'] ?? 'app'))
    }
  }
  return null
}

/** `sceneAppConfigProblem` over a scenes.json array: the first problem, or null. */
export function scenesAppConfigProblem(scenes: unknown): string | null {
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const problem = sceneAppConfigProblem(scene)
    if (problem) {
      return problem
    }
  }
  return null
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
  // As the tags say it: reading and writing files gained together is one.
  return sceneAccessTags(changes.gained)
    .map((tag) =>
      tag.key === 'files' && changes.before.includes('assets') ? `${tag.label} (was the assets folder only)` : tag.label
    )
    .join(', ')
}

/**
 * config.json with `permissions` set to `permissions`, or null when it stays
 * as it is: already that list, any list at all when `onlyMissing`, or a file
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
  if (!config) {
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

function withSourcesPermissions(
  sources: unknown,
  onlyMissing: boolean,
  without: readonly ScenePermission[]
): Record<string, unknown> | null {
  const strings = stringSources(sources)
  if (!hasJavaScriptSource(strings)) {
    return null
  }
  const { detected } = detectSources(strings, record(sources))
  const next = configWithPermissions(
    strings['config.json'],
    without.length > 0 ? detected.filter((permission) => !without.includes(permission)) : detected,
    onlyMissing
  )
  return next === null ? null : { ...(record(sources) ?? {}), 'config.json': next }
}

/**
 * The scene with every JavaScript app's config.json `permissions` set from
 * its code, the way a save leaves it: a config.json that does not parse is
 * left alone.
 * With `onlyMissing`, only apps with no list at all get one (the cloud's
 * read-time stamp of scenes that predate the lists). `without` leaves names
 * out of a list written here (the cloud's push to a firmware from before a
 * permission existed, so the payload changes when the firmware starts
 * reading it). Returns the same object when nothing changes.
 */
export function withAppPermissions<T>(
  scene: T,
  options: { onlyMissing?: boolean; without?: readonly ScenePermission[] } = {}
): T {
  const sceneRecord = record(scene)
  if (!sceneRecord) {
    return scene
  }
  const onlyMissing = options.onlyMissing === true
  const without = options.without ?? []
  const apps = record(sceneRecord['apps'])
  let nextApps: Record<string, unknown> | null = null
  for (const [keyword, app] of Object.entries(apps ?? {})) {
    const appRecord = record(app)
    const sources = withSourcesPermissions(appRecord?.['sources'], onlyMissing, without)
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
    const sources =
      nodeRecord?.['type'] === 'app' && data ? withSourcesPermissions(data['sources'], onlyMissing, without) : null
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

// ---------------------------------------------------------------------------
// The services an app reads keys of, from its code (docs/service-keys.md "A
// service the registry does not know"): `frameos.getSetting('x', 'field')`
// and `frameos.secret('x', 'field')` with a literal first argument. A save
// ADDS what the code names to config.json `settings` (never removes: a name
// read through a variable cannot be seen), and a `services` stub for an id
// the registry does not know and the app does not define yet.
// ---------------------------------------------------------------------------

const settingCallPattern =
  /\bframeos\s*\.\s*(?:getSetting|secret)\s*\(\s*(['"`])([A-Za-z][A-Za-z0-9_]{0,40})\1(?:\s*,\s*(['"`])([A-Za-z][A-Za-z0-9_]{0,40})\3)?/g

/** Service id → the field names the code reads of it (literal second arguments). */
export function detectServiceReads(sources: unknown): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const [name, text] of Object.entries(stringSources(sources) ?? {})) {
    if (!javascriptSourcePattern.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) {
      continue
    }
    for (const match of text.matchAll(settingCallPattern)) {
      const service = match[2]
      if (!service) {
        continue
      }
      const fields = (found[service] ??= [])
      const field = match[4]
      if (field && !fields.includes(field)) {
        fields.push(field)
      }
    }
  }
  return found
}

function configWithServiceReads(text: string | undefined, reads: Record<string, string[]>): string | null {
  const ids = Object.keys(reads).sort()
  if (ids.length === 0) {
    return null
  }
  const config = text === undefined ? {} : parseConfig(text)
  if (!config) {
    return null
  }
  const current = stringList(config['settings'])
  const missing = ids.filter((id) => !current.includes(id))
  const services = record(config['services']) ?? {}
  const stubs: Record<string, unknown> = {}
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(SERVICE_REGISTRY, id) || services[id] !== undefined) {
      continue
    }
    stubs[id] = { title: id, fields: (reads[id] ?? []).map((field) => ({ name: field, label: field })) }
  }
  if (missing.length === 0 && Object.keys(stubs).length === 0) {
    return null
  }
  const entries = Object.entries(config)
  const settings = [...current, ...missing]
  const settingsAt = entries.findIndex(([key]) => key === 'settings')
  if (settingsAt >= 0) {
    entries[settingsAt] = ['settings', settings]
  } else {
    const permissionsAt = entries.findIndex(([key]) => key === 'permissions')
    entries.splice(permissionsAt >= 0 ? permissionsAt : entries.length, 0, ['settings', settings])
  }
  if (Object.keys(stubs).length > 0) {
    const servicesAt = entries.findIndex(([key]) => key === 'services')
    if (servicesAt >= 0) {
      entries[servicesAt] = ['services', { ...services, ...stubs }]
    } else {
      const at = entries.findIndex(([key]) => key === 'settings')
      entries.splice(at + 1, 0, ['services', stubs])
    }
  }
  if (text === undefined) {
    return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`
  }
  const indent = /\n( +)"/.exec(text)?.[1]?.length ?? 2
  return `${JSON.stringify(Object.fromEntries(entries), null, indent)}${text.endsWith('\n') ? '\n' : ''}`
}

function withSourcesServiceReads(sources: unknown): Record<string, unknown> | null {
  const strings = stringSources(sources)
  if (!hasJavaScriptSource(strings)) {
    return null
  }
  const next = configWithServiceReads(strings['config.json'], detectServiceReads(strings))
  return next === null ? null : { ...(record(sources) ?? {}), 'config.json': next }
}

/**
 * The scene with every JavaScript app's config.json `settings` holding the
 * services its code reads keys of (and a `services` stub for one the
 * registry does not know), the way a save leaves it. Only adds; a
 * config.json that does not parse is left alone. Returns the same object
 * when nothing changes.
 */
export function withAppServiceReads<T>(scene: T): T {
  const sceneRecord = record(scene)
  if (!sceneRecord) {
    return scene
  }
  const apps = record(sceneRecord['apps'])
  let nextApps: Record<string, unknown> | null = null
  for (const [keyword, app] of Object.entries(apps ?? {})) {
    const appRecord = record(app)
    const sources = withSourcesServiceReads(appRecord?.['sources'])
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
    const sources = nodeRecord?.['type'] === 'app' && data ? withSourcesServiceReads(data['sources']) : null
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

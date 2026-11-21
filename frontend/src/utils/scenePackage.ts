// A scene as files (docs/scene-packages.md): the one way a scene object is
// laid out as a folder or a zip, on every plane and runtime. The scene stays
// a JSON object in every API; this is its file form, pinned by
// docs/scene-package-fixtures.json (the Python port is
// backend/app/utils/scene_package.py, the runtime's reader
// frameos/src/frameos/scene_package.nim).
//
//   scene.json             the scene, every app's `sources` taken out
//   apps/<keyword>/<file>  each file of `apps[keyword].sources`, as it is
//   assets/...             reserved
//
// A set of scenes (a template zip, a repo sample, a frame's deployed set) is
// a folder of scene folders, as the scene editor's file tree shows it:
//
//   template.json          the listing; `scenes` the folders in order
//   <scene folder>/scene.json, <scene folder>/apps/<keyword>/<file>
//
// Readers also take the form before packages: template.json naming a
// scenes.json (`"scenes": "./scenes.json"`) holding the whole array.

export const SCENE_FILE = 'scene.json'
export const TEMPLATE_FILE = 'template.json'
export const APPS_FOLDER = 'apps'
export const ASSETS_FOLDER = 'assets'

/** A scene object as the planes keep it (FrameScene and the cloud's rows):
 * only `apps[*].sources` is read here, the rest goes through as it is. */
export type PackageScene = Record<string, unknown>

/** A package's files: path → text. */
export type PackageFiles = Record<string, string>

export class ScenePackageError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'ScenePackageError'
  }
}

const TEST_FILE = /\.test\.(ts|tsx|js|jsx)$/i

/** `<name>.test.ts` (.tsx, .js, .jsx): an app's own tests, which run in the
 * editor and never on a frame (the planes leave them out of what they send). */
export function isAppTestFile(path: string): boolean {
  return TEST_FILE.test(path)
}

/** `scene` with the test files of `stored` (the plane's copy of the same
 * scene) put back into each app both have: a frame is never sent an app's
 * tests, so a scene its code editor saves back has none
 * (docs/scene-packages.md). A test file the scene carries itself wins. */
export function keepAppTestFiles(scene: PackageScene, stored: PackageScene | null | undefined): PackageScene {
  if (!stored || !isObject(scene.apps) || !isObject(stored.apps)) {
    return scene
  }
  const apps: Record<string, unknown> = { ...scene.apps }
  for (const [keyword, app] of Object.entries(apps)) {
    const before = (stored.apps as Record<string, unknown>)[keyword]
    if (!isObject(app) || !isObject(before) || !isObject(before.sources)) {
      continue
    }
    const sources: Record<string, unknown> = isObject(app.sources) ? { ...app.sources } : {}
    for (const [path, text] of Object.entries(before.sources)) {
      if (isAppTestFile(path) && typeof text === 'string' && !(path in sources)) {
        sources[path] = text
      }
    }
    apps[keyword] = { ...app, sources }
  }
  return { ...scene, apps }
}

/** The folder an app's files go in: its keyword, with `%` and `/` escaped. */
export function appFolderName(keyword: string): string {
  return keyword.replace(/%/g, '%25').replace(/\//g, '%2F')
}

/** The keyword of an app folder (appFolderName's inverse). */
export function keywordOfAppFolder(folder: string): string {
  return folder.replace(/%2F/gi, '/').replace(/%25/g, '%')
}

/** Whether `path` may name a file in a package: relative, `/`-separated, no
 * empty, `.` or `..` segment, no backslash or NUL. */
export function isSafePackagePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Packing options. `withoutTests`: leave every app's test files out (what a
 * frame is sent). */
export interface PackOptions {
  withoutTests?: boolean | undefined
}

/** One scene's files: `scene.json` (2-space JSON) and every app file. An app
 * file whose path is not safe is refused. */
export function scenePackageFiles(scene: PackageScene, options: PackOptions = {}): PackageFiles {
  const files: PackageFiles = {}
  const appFiles: PackageFiles = {}
  const sceneJson: Record<string, unknown> = { ...scene }
  if (isObject(scene.apps)) {
    const apps: Record<string, unknown> = {}
    for (const [keyword, app] of Object.entries(scene.apps)) {
      if (!isObject(app) || !isObject(app.sources)) {
        apps[keyword] = app
        continue
      }
      const { sources, ...rest } = app
      apps[keyword] = rest
      for (const [path, text] of Object.entries(sources as Record<string, unknown>)) {
        if (typeof text !== 'string' || (options.withoutTests && isAppTestFile(path))) {
          continue
        }
        if (!isSafePackagePath(path)) {
          throw new ScenePackageError('unsafe_path', `The app ${keyword} has a file named ${JSON.stringify(path)}`)
        }
        appFiles[`${APPS_FOLDER}/${appFolderName(keyword)}/${path}`] = text
      }
    }
    sceneJson.apps = apps
  }
  files[SCENE_FILE] = JSON.stringify(sceneJson, null, 2) + '\n'
  return Object.assign(files, appFiles)
}

/** A scene from its files (scenePackageFiles' inverse). `apps/<keyword>/...`
 * files go back into `apps[keyword].sources`, after whatever sources
 * scene.json still carries; a folder of an app scene.json does not name
 * becomes that app. Anything else (assets/, stray files) is left alone. */
export function sceneFromPackageFiles(files: PackageFiles): PackageScene {
  const text = files[SCENE_FILE]
  if (typeof text !== 'string') {
    throw new ScenePackageError('missing_scene', 'The package has no scene.json')
  }
  let scene: unknown
  try {
    scene = JSON.parse(text)
  } catch (error) {
    throw new ScenePackageError('invalid_scene', `scene.json is not JSON: ${(error as Error).message}`)
  }
  if (!isObject(scene)) {
    throw new ScenePackageError('invalid_scene', 'scene.json is not one scene object')
  }
  const prefix = `${APPS_FOLDER}/`
  const apps: Record<string, unknown> = isObject(scene.apps) ? { ...scene.apps } : {}
  let sawApp = false
  for (const path of Object.keys(files).sort()) {
    if (!path.startsWith(prefix)) {
      continue
    }
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash <= 0 || !isSafePackagePath(path)) {
      throw new ScenePackageError('unsafe_path', `The package has a file named ${JSON.stringify(path)}`)
    }
    const keyword = keywordOfAppFolder(rest.slice(0, slash))
    const app = isObject(apps[keyword]) ? { ...(apps[keyword] as Record<string, unknown>) } : {}
    const sources = isObject(app.sources) ? { ...(app.sources as Record<string, unknown>) } : {}
    delete app.sources
    sources[rest.slice(slash + 1)] = files[path]
    apps[keyword] = { ...app, sources }
    sawApp = true
  }
  if (sawApp || isObject(scene.apps)) {
    scene.apps = apps
  }
  return scene
}

const UNSAFE_FOLDER_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g
const RESERVED_FOLDERS = new Set([APPS_FOLDER, ASSETS_FOLDER])

function folderBase(text: string): string {
  return text
    .replace(UNSAFE_FOLDER_CHARACTERS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 64)
    .trim()
}

/** The folder each scene of a set goes in, in order: its name made safe for
 * a file system (the id when the name leaves nothing), and the id beside it
 * when the name is taken, reserved or ends in a file's extension. */
export function sceneFolderNames(scenes: PackageScene[]): string[] {
  const taken = new Set<string>()
  return scenes.map((scene) => {
    const id = typeof scene.id === 'string' ? scene.id : ''
    const name = typeof scene.name === 'string' ? scene.name : ''
    const idBase = folderBase(id) || 'scene'
    let folder = folderBase(name) || idBase
    const clashes = (candidate: string): boolean =>
      taken.has(candidate.toLowerCase()) ||
      RESERVED_FOLDERS.has(candidate.toLowerCase()) ||
      /\.(json|jpe?g|png|webp|gif|zip)$/i.test(candidate)
    if (clashes(folder)) {
      folder = folder === idBase ? `${idBase} (scene)` : `${folder} (${idBase})`
    }
    let candidate = folder
    for (let n = 2; clashes(candidate); n++) {
      candidate = `${folder} ${n}`
    }
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/** A set's files: template.json (the manifest given, `scenes` set to the
 * folders in order) and every scene's package under its folder. */
export function setPackageFiles(
  scenes: PackageScene[],
  manifest: Record<string, unknown> = {},
  options: PackOptions = {}
): PackageFiles {
  const folders = sceneFolderNames(scenes)
  const files: PackageFiles = {}
  files[TEMPLATE_FILE] = JSON.stringify({ ...manifest, scenes: folders.map((folder) => `./${folder}`) }, null, 2) + '\n'
  scenes.forEach((scene, index) => {
    for (const [path, text] of Object.entries(scenePackageFiles(scene, options))) {
      files[`${folders[index]}/${path}`] = text
    }
  })
  return files
}

function stripDotSlash(path: string): string {
  let out = path
  while (out.startsWith('./')) {
    out = out.slice(2)
  }
  return out.replace(/\/+$/, '')
}

/** The files under `folder` (`""` for all), their paths relative to it. */
function filesUnder(files: PackageFiles, folder: string): PackageFiles {
  if (!folder) {
    return files
  }
  const prefix = `${folder}/`
  const out: PackageFiles = {}
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith(prefix)) {
      out[path.slice(prefix.length)] = text
    }
  }
  return out
}

/** The folder a set's files start in: the folder of its shallowest
 * template.json (a template zip keeps everything under `<name>/`), else of
 * its shallowest scene.json's parent, else of its shallowest scenes.json;
 * `""` for the top. */
export function packageRoot(paths: string[]): string {
  const depth = (path: string): number => path.split('/').length
  const shallowest = (pattern: RegExp): string | null =>
    paths.filter((path) => pattern.test(path)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0] ?? null
  const dir = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
  const template = shallowest(/(^|\/)template\.json$/)
  if (template !== null) {
    return dir(template)
  }
  // A scene folder's parent: `Clock/scene.json` is a set of one folder at
  // the top (the same scene as reading Clock/ as one package).
  const scene = shallowest(/(^|\/)scene\.json$/)
  if (scene !== null) {
    return dir(dir(scene))
  }
  const legacy = shallowest(/(^|\/)scenes\.json$/)
  return legacy !== null ? dir(legacy) : ''
}

export interface ReadSet {
  scenes: PackageScene[]
  /** template.json as it is, or null without one. */
  manifest: Record<string, unknown> | null
}

/** A set's scenes from its files, whichever form they are in: scene folders
 * (in template.json's `scenes` order, then any folder it does not name by
 * name), one scene package at the top, or a legacy scenes.json. Paths are
 * relative to `root` (packageRoot's by default). */
export function setFromPackageFiles(files: PackageFiles, root: string = packageRoot(Object.keys(files))): ReadSet {
  const own = filesUnder(files, root)
  let manifest: Record<string, unknown> | null = null
  if (typeof own[TEMPLATE_FILE] === 'string') {
    try {
      const parsed = JSON.parse(own[TEMPLATE_FILE])
      manifest = isObject(parsed) ? parsed : null
    } catch (error) {
      throw new ScenePackageError('invalid_template', `template.json is not JSON: ${(error as Error).message}`)
    }
    if (!manifest) {
      throw new ScenePackageError('invalid_template', 'template.json is not an object')
    }
  }
  const listed = manifest?.scenes
  if (typeof listed === 'string' || (listed === undefined && typeof own['scenes.json'] === 'string')) {
    const path = typeof listed === 'string' ? stripDotSlash(listed) : 'scenes.json'
    const text = own[path]
    if (typeof text !== 'string') {
      throw new ScenePackageError('missing_scenes', `The package has no ${path}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new ScenePackageError('invalid_scenes', `${path} is not JSON: ${(error as Error).message}`)
    }
    const scenes = Array.isArray(parsed) ? parsed : null
    if (!scenes || !scenes.every(isObject)) {
      throw new ScenePackageError('invalid_scenes', `${path} is not a list of scenes`)
    }
    return { scenes: scenes as PackageScene[], manifest }
  }
  if (typeof own[SCENE_FILE] === 'string') {
    return { scenes: [sceneFromPackageFiles(own)], manifest }
  }
  const folders = Array.from(
    new Set(
      Object.keys(own)
        .filter((path) => path.endsWith(`/${SCENE_FILE}`) && path.split('/').length === 2)
        .map((path) => path.slice(0, -SCENE_FILE.length - 1))
    )
  ).sort()
  const order: string[] = []
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const folder = typeof entry === 'string' ? stripDotSlash(entry) : ''
      if (!folder || !isSafePackagePath(folder) || folder.includes('/')) {
        throw new ScenePackageError('invalid_template', `template.json lists ${JSON.stringify(entry)}`)
      }
      if (!folders.includes(folder)) {
        throw new ScenePackageError('missing_scene', `template.json lists ${folder}, which has no scene.json`)
      }
      if (!order.includes(folder)) {
        order.push(folder)
      }
    }
  }
  for (const folder of folders) {
    if (!order.includes(folder)) {
      order.push(folder)
    }
  }
  if (order.length === 0) {
    throw new ScenePackageError('missing_scenes', 'The package holds no scene')
  }
  return { scenes: order.map((folder) => sceneFromPackageFiles(filesUnder(own, folder))), manifest }
}

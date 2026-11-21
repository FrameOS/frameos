import { unzipSync } from 'fflate'
import type { FrameScene } from '../types'
import { type PackageFiles, type ReadSet as PackagedSet, ScenePackageError, packageRoot, setFromPackageFiles } from './scenePackage'

// "Upload scene" in the frame's Add scene drawer. Runs entirely in the
// browser so it works on every control plane (backend, on-device admin,
// cloud) — the self-hosted /api/templates zip parser is not available on the
// cloud, and the scenes only need to reach frameLogic.applyTemplate anyway.
//
// Accepted inputs:
//   .zip   a template export: the shallowest template.json (name/description)
//          plus its scenes, a folder per scene (docs/scene-packages.md) or the
//          sibling scenes.json of a zip from before packages — what the
//          backend's parse_template_zip and the cloud store's validateSceneZip read.
//          The cover next to them (the manifest's `image`, conventionally
//          ./image.jpg) comes along as a Blob so the new scene's tile is not
//          blank until the frame renders it.
//   .json  a scenes array, or a single scene object (must carry nodes+edges).

export interface ParsedSceneUpload {
  scenes: Partial<FrameScene>[]
  name?: string
  description?: string
  /** The template's cover image, when the zip ships one. */
  image?: Blob
}

export class SceneUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SceneUploadError'
  }
}

// Same caps as the cloud store's validateSceneZip: a template zip is a few
// JSON files and a cover image, anything bigger is not one.
const maxZipEntries = 200
const maxZipUncompressedBytes = 32 * 1024 * 1024

// The manifest and the scenes: a legacy scenes.json, or scene folders (each
// scene.json and its apps' files, docs/scene-packages.md).
const zipEntryPattern = /(^|\/)(template\.json|scenes\.json|scene\.json)$|(^|\/)apps\//
// The cover the interchange format ships next to the manifest. Only the
// conventional name is inflated up front; a manifest that points elsewhere
// gets its file inflated in a second, targeted pass.
const zipCoverPattern = /(^|\/)image\.(jpe?g|png|webp|gif)$/i
// Same cap as the cloud store's preview image; the backend thumbnails
// whatever it gets, but nobody needs a 20 MB cover on a scene tile.
const maxCoverBytes = 4 * 1024 * 1024

function depth(path: string): number {
  return path.split('/').length - 1
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** The raster format of `bytes` by magic number — the `.jpg` in the zip is a convention, not a promise. */
export function detectImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

/** Resolve the manifest's `image` (e.g. "./image.jpg") against the folder holding template.json. */
function coverPathFromManifest(folder: string, image: unknown): string | undefined {
  if (typeof image !== 'string' || !image.trim()) {
    return undefined
  }
  let path = image.trim()
  // Remote covers (a repository URL) are not in the zip.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return undefined
  }
  while (path.startsWith('./')) {
    path = path.slice(2)
  }
  if (path.startsWith('/') || path.split('/').includes('..') || !path) {
    return undefined
  }
  return `${folder}${path}`
}

function coverBlob(files: Record<string, Uint8Array>, coverPath: string | undefined): Blob | undefined {
  const bytes = coverPath ? files[coverPath] : undefined
  if (!bytes || bytes.length === 0 || bytes.length > maxCoverBytes) {
    return undefined
  }
  const type = detectImageMimeType(bytes)
  if (!type) {
    return undefined
  }
  return new Blob([bytes as BlobPart], { type })
}

function parseJsonBytes(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new SceneUploadError(`${what} is not valid JSON`)
  }
}

function isSceneLike(value: unknown): value is Partial<FrameScene> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return Array.isArray(record.nodes) && Array.isArray(record.edges)
}

function scenesFromJson(value: unknown, what: string): Partial<FrameScene>[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new SceneUploadError(`${what} contains no scenes`)
    }
    if (!value.every(isSceneLike)) {
      throw new SceneUploadError(`${what} must be an array of scenes, each with nodes and edges`)
    }
    return value
  }
  if (isSceneLike(value)) {
    return [value]
  }
  throw new SceneUploadError(`${what} must be a scene (with nodes and edges) or an array of scenes`)
}

function parseZip(bytes: Uint8Array): ParsedSceneUpload {
  let entryCount = 0
  let totalUncompressed = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        entryCount += 1
        totalUncompressed += file.originalSize ?? 0
        if (entryCount > maxZipEntries || totalUncompressed > maxZipUncompressedBytes) {
          throw new Error('zip_bounds_exceeded')
        }
        // Inflate only the files we read: the two manifests and the
        // conventionally named cover. Anything else stays compressed.
        return zipEntryPattern.test(file.name) || zipCoverPattern.test(file.name)
      },
    })
  } catch {
    throw new SceneUploadError('This is not a readable template .zip')
  }

  const byShallowest = (a: string, b: string): number => depth(a) - depth(b) || a.localeCompare(b)
  const manifestPath = Object.keys(files)
    .filter((name) => /(^|\/)template\.json$/.test(name))
    .sort(byShallowest)[0]
  // Scene folders (docs/scene-packages.md), a scenes.json next to the
  // manifest, or a zip of just a scenes.json or one scene package (no
  // manifest: the name then comes from the scene itself).
  const texts: PackageFiles = {}
  const decoder = new TextDecoder()
  for (const [name, data] of Object.entries(files)) {
    if (!zipCoverPattern.test(name)) {
      texts[name] = decoder.decode(data)
    }
  }
  const root = packageRoot(Object.keys(texts))
  let read: PackagedSet
  try {
    read = setFromPackageFiles(texts, root)
  } catch (error) {
    throw new SceneUploadError(
      error instanceof ScenePackageError && error.code === 'missing_scenes'
        ? manifestPath
          ? 'The zip has a template.json but no scenes next to it'
          : 'No scenes found in the zip'
        : `This template .zip cannot be read: ${(error as Error).message}`
    )
  }
  const scenes = scenesFromJson(read.scenes, 'The zip\'s scenes')
  const result: ParsedSceneUpload = { scenes }
  const folder = root ? `${root}/` : ''
  // Without a manifest the cover can only be the conventional image.jpg.
  let coverPath: string | undefined = `${folder}image.jpg`
  if (read.manifest) {
    const record = read.manifest
    if (typeof record.name === 'string' && record.name.trim()) {
      result.name = record.name.trim()
    }
    if (typeof record.description === 'string' && record.description.trim()) {
      result.description = record.description.trim()
    }
    // A manifest that points elsewhere wins; one that points nowhere usable
    // (a remote URL, null) leaves the conventional name as the fallback.
    coverPath = coverPathFromManifest(folder, record.image) ?? coverPath
  }
  if (coverPath && !(coverPath in files)) {
    // The manifest names a cover the first pass did not inflate (an
    // unconventional file name); inflate just that one.
    try {
      const target = coverPath
      Object.assign(files, unzipSync(bytes, { filter: (file) => file.name === target }))
    } catch {
      // A cover that will not inflate is not worth failing the upload over.
    }
  }
  const image = coverBlob(files, coverPath)
  if (image) {
    result.image = image
  }
  return result
}

/** Parse an uploaded template .zip or scenes .json into scenes ready for applyTemplate. Throws SceneUploadError. */
export function parseSceneUpload(bytes: Uint8Array, filename: string): ParsedSceneUpload {
  const lowerName = filename.toLowerCase()
  if (lowerName.endsWith('.zip')) {
    return parseZip(bytes)
  }
  if (lowerName.endsWith('.json')) {
    return { scenes: scenesFromJson(parseJsonBytes(bytes, filename || 'The file'), filename || 'The file') }
  }
  // Unknown extension: trust the bytes over the name.
  if (looksLikeZip(bytes)) {
    return parseZip(bytes)
  }
  throw new SceneUploadError('Upload a template .zip or a scenes .json file')
}

/** True when any node arrives without a usable position, so the editor should lay the scene out on first open. */
export function sceneNeedsAutoArrange(scene: Partial<FrameScene>): boolean {
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : []
  return (
    nodes.length > 0 && nodes.some((node) => !Number.isFinite(node?.position?.x) || !Number.isFinite(node?.position?.y))
  )
}

import { unzipSync } from 'fflate'
import type { FrameScene } from '../types'

// "Upload scene" in the frame's Add scene drawer. Runs entirely in the
// browser so it works on every control plane (backend, on-device admin,
// cloud) — the self-hosted /api/templates zip parser is not available on the
// cloud, and the scenes only need to reach frameLogic.applyTemplate anyway.
//
// Accepted inputs:
//   .zip   a template export: the shallowest template.json (name/description)
//          plus its sibling scenes.json — the same layout the backend's
//          parse_template_zip and the cloud store's validateSceneZip read.
//   .json  a scenes array, or a single scene object (must carry nodes+edges).

export interface ParsedSceneUpload {
  scenes: Partial<FrameScene>[]
  name?: string
  description?: string
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

const zipEntryPattern = /(^|\/)(template\.json|scenes\.json)$/

function depth(path: string): number {
  return path.split('/').length - 1
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
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
        // Inflate only the two files we read; a cover image stays compressed.
        return zipEntryPattern.test(file.name)
      },
    })
  } catch {
    throw new SceneUploadError('This is not a readable template .zip')
  }

  const byShallowest = (a: string, b: string): number => depth(a) - depth(b) || a.localeCompare(b)
  const manifestPath = Object.keys(files)
    .filter((name) => /(^|\/)template\.json$/.test(name))
    .sort(byShallowest)[0]
  // A zip of just a scenes.json (no manifest) is still a scene export worth
  // installing; the name then comes from the scene itself.
  const scenesPath = manifestPath
    ? `${manifestPath.slice(0, manifestPath.length - 'template.json'.length)}scenes.json`
    : Object.keys(files)
        .filter((name) => /(^|\/)scenes\.json$/.test(name))
        .sort(byShallowest)[0]
  const scenesBytes = scenesPath ? files[scenesPath] : undefined
  if (!scenesBytes) {
    throw new SceneUploadError(
      manifestPath ? 'The zip has a template.json but no scenes.json next to it' : 'No scenes.json found in the zip'
    )
  }

  const scenes = scenesFromJson(parseJsonBytes(scenesBytes, 'scenes.json'), 'scenes.json')
  const result: ParsedSceneUpload = { scenes }
  const manifestBytes = manifestPath ? files[manifestPath] : undefined
  if (manifestBytes) {
    const manifest = parseJsonBytes(manifestBytes, 'template.json')
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new SceneUploadError('template.json must be a JSON object')
    }
    const record = manifest as Record<string, unknown>
    if (typeof record.name === 'string' && record.name.trim()) {
      result.name = record.name.trim()
    }
    if (typeof record.description === 'string' && record.description.trim()) {
      result.description = record.description.trim()
    }
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
    nodes.length > 0 &&
    nodes.some((node) => !Number.isFinite(node?.position?.x) || !Number.isFinite(node?.position?.y))
  )
}

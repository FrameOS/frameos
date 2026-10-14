// The Photos HTTP contract (docs/photos.md), the same on the backend and the
// cloud. apiFetch adds the backend's project scope; URLs that end up in the
// DOM (an <img src>) add it themselves, plus the ingress base path.
import type { FrameId } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { getBasePath } from '../../utils/getBasePath'
import { projectApiPath, projectApiPathFromCache } from '../../utils/projectApi'
import { secureToken } from '../../utils/secureToken'

export interface PhotoEntry {
  path: string
  name: string
  kind: 'file' | 'folder'
  size: number
  mtime: number
  content_type: string | null
  width: number | null
  height: number | null
  status?: 'ready' | 'blocked'
  /** Folders: direct children. */
  items?: number
  /** Folders: files anywhere below. */
  files?: number
  /** Folders: an image to show for the folder. */
  cover?: string | null
  /** Files: the photo's color profile, a frame asset sidecar's `colors` (docs/photos.md, "Colors"). */
  colors?: PhotoColors | null
}

/** The `colors` object of a `.frameos.json` sidecar (docs/asset-color-profiles.md). */
export type PhotoColors = Record<string, unknown>

export type PhotosProblem = 'not_writable' | 'not_persistent' | 'storage_unavailable' | 'suspended'

export interface PhotosStatus {
  ready: boolean
  problem: PhotosProblem | null
  message: string | null
  location: string | null
  used_bytes: number
  quota_bytes: number | null
  free_bytes: number | null
  max_upload_bytes: number
  accepts: string[] | null
  scanning: string[]
}

export interface PhotoShare {
  token: string
  path: string
  /** The frame the link was made for; null for the folder's general link. */
  frame_id: FrameId | null
  /** A custom link's label; null for the general and per-frame links. */
  name: string | null
  url: string
  created_at: number
  /** When something last read through the link (seconds); null until then. */
  last_used_at: number | null
}

export class PhotosApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  404: 'Not found.',
  409: 'Something with that name already exists.',
  413: 'That file is too large.',
  415: 'That type of file cannot be stored here.',
  422: 'That file cannot be stored.',
  503: 'Photos is not available right now.',
  507: 'Your photo storage is full.',
}

async function errorFromResponse(response: Response): Promise<PhotosApiError> {
  let message = ''
  try {
    const body = await response.json()
    const detail = body?.detail ?? body?.message ?? body?.error
    if (typeof detail === 'string') {
      message = detail
    }
  } catch {
    // Not JSON; fall back to the status.
  }
  // The cloud answers machine codes (`storage_quota_exceeded`); show those as
  // the status's sentence instead.
  if (!message || /^[a-z_]+$/.test(message)) {
    message = STATUS_MESSAGES[response.status] ?? `Request failed (${response.status})`
  }
  return new PhotosApiError(response.status, message)
}

async function photosJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    throw await errorFromResponse(response)
  }
  return (await response.json()) as T
}

function jsonPost<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return photosJson<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function fetchPhotosStatus(): Promise<PhotosStatus> {
  return photosJson<PhotosStatus>('/api/photos/status')
}

export async function fetchPhotoFolder(path: string): Promise<PhotoEntry[]> {
  const result = await photosJson<{ path: string; entries: PhotoEntry[] }>(
    `/api/photos/files?${new URLSearchParams({ path }).toString()}`
  )
  return result.entries ?? []
}

export async function createPhotoFolder(path: string): Promise<PhotoEntry> {
  return (await jsonPost<{ entry: PhotoEntry }>('/api/photos/folders', { path })).entry
}

export async function movePhotos(paths: string[], to: string): Promise<{ from: string; to: string }[]> {
  return (await jsonPost<{ moved: { from: string; to: string }[] }>('/api/photos/move', { paths, to })).moved ?? []
}

export async function renamePhoto(path: string, name: string): Promise<PhotoEntry> {
  return (await jsonPost<{ entry: PhotoEntry }>('/api/photos/rename', { path, name })).entry
}

/** Sets a photo's color profile; `null` removes it. */
export async function setPhotoColors(path: string, colors: PhotoColors | null): Promise<PhotoEntry> {
  return (await jsonPost<{ entry: PhotoEntry }>('/api/photos/colors', { path, colors })).entry
}

export async function deletePhotos(paths: string[]): Promise<number> {
  return (await jsonPost<{ deleted: number }>('/api/photos/delete', { paths })).deleted ?? 0
}

export async function fetchPhotoShares(): Promise<PhotoShare[]> {
  return (await photosJson<{ shares: PhotoShare[] }>('/api/photos/shares')).shares ?? []
}

/**
 * The folder's general link, with `frameId` the link for that one frame (both
 * made when missing), or with `name` a new custom link every time.
 */
export async function createPhotoShare(
  path: string,
  frameId: FrameId | null = null,
  name: string | null = null
): Promise<PhotoShare> {
  const body: Record<string, unknown> = { path }
  if (name !== null) {
    body.name = name
  } else if (frameId !== null) {
    body.frame_id = frameId
  }
  return (await jsonPost<{ share: PhotoShare }>('/api/photos/shares', body)).share
}

export async function deletePhotoShare(token: string): Promise<void> {
  const response = await apiFetch(`/api/photos/shares/${encodeURIComponent(token)}`, { method: 'DELETE' })
  if (!response.ok) {
    throw await errorFromResponse(response)
  }
}

function browserPhotosUrl(suffix: string, params: Record<string, string>): string {
  return `${getBasePath()}${projectApiPathFromCache(`/api/photos/${suffix}`)}?${new URLSearchParams(params).toString()}`
}

/** An <img src> for a file's thumbnail. 404s when there is none. */
export function photoThumbUrl(entry: Pick<PhotoEntry, 'path' | 'mtime' | 'size'>): string {
  // mtime and size only bust the browser cache after a file is replaced.
  return browserPhotosUrl('thumb', { path: entry.path, v: `${entry.mtime}-${entry.size}` })
}

export function photoFileUrl(path: string, download = false): string {
  return browserPhotosUrl('file', download ? { path, download: '1' } : { path })
}

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

interface ChunkResponse {
  status: number
  payload: any
}

function postBytes(url: string, body: Blob, contentType: string, onProgress?: (sent: number) => void) {
  return new Promise<ChunkResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${getBasePath()}${url}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded)
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'))
    xhr.onload = () => {
      let payload: any = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        // Status carries the outcome.
      }
      resolve({ status: xhr.status, payload })
    }
    xhr.send(body)
  })
}

function chunkError(response: ChunkResponse): PhotosApiError {
  const detail = response.payload?.detail ?? response.payload?.message ?? response.payload?.error
  const message =
    typeof detail === 'string' && detail && !/^[a-z_]+$/.test(detail)
      ? detail
      : STATUS_MESSAGES[response.status] ?? `Upload failed (${response.status})`
  return new PhotosApiError(response.status, message)
}

/** Upload one file into `folder` in 4 MiB chunks. Resolves with the stored entry. */
export async function uploadPhoto(
  folder: string,
  file: File,
  onProgress?: (uploadedBytes: number) => void,
  filename: string = file.name
): Promise<PhotoEntry> {
  const url = await projectApiPath('/api/photos/upload')
  // A 409 means the server lost earlier chunks (a restart); start over once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const uploadId = secureToken(18)
    const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES))
    let restart = false
    onProgress?.(0)
    for (let index = 0; index < totalChunks; index++) {
      const start = index * UPLOAD_CHUNK_BYTES
      const end = Math.min(file.size, start + UPLOAD_CHUNK_BYTES)
      const params = new URLSearchParams({
        path: folder,
        filename,
        upload_id: uploadId,
        offset: String(start),
        complete: index === totalChunks - 1 ? '1' : '0',
      })
      const response = await postBytes(
        `${url}?${params.toString()}`,
        file.slice(start, end),
        'application/octet-stream',
        (sent) => onProgress?.(Math.min(end, start + sent))
      )
      if (response.status === 409 && attempt === 0) {
        restart = true
        break
      }
      if (response.status < 200 || response.status >= 300) {
        throw chunkError(response)
      }
      onProgress?.(end)
      if (index === totalChunks - 1) {
        const entry = response.payload?.entry
        if (!entry) {
          throw new PhotosApiError(response.status, 'The server did not confirm the upload.')
        }
        return entry as PhotoEntry
      }
    }
    if (!restart) {
      break
    }
  }
  throw new PhotosApiError(409, 'Upload failed. Try again.')
}

/** The share link a frame plays. The backend answers a root-relative path,
 * because only the frame knows how it reaches the backend: its
 * server_scheme://server_host:server_port goes in front. */
export function shareUrlForFrame(
  share: PhotoShare,
  frame: { server_scheme?: string | null; server_host?: string | null; server_port?: number | null }
): string | null {
  if (/^https?:\/\//i.test(share.url)) {
    return share.url
  }
  const host = (frame.server_host ?? '').trim()
  if (!host) {
    return null
  }
  const scheme = frame.server_scheme === 'https' ? 'https' : 'http'
  const port = frame.server_port ? `:${frame.server_port}` : ''
  const path = share.url.startsWith('/') ? share.url : `/${share.url}`
  return `${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port}${path}`
}

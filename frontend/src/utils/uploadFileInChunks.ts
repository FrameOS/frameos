import { getBasePath } from './getBasePath'
import { DEFAULT_ASSET_STORAGE, frameAssetsApiPath, type AssetStorageId } from './frameAssetsApi'
import { secureToken } from './secureToken'
import type { FrameId } from '../types'

const DEFAULT_UPLOAD_CHUNK_SIZE = 512 * 1024

interface UploadFileInChunksOptions {
  frameId: FrameId
  suffix: string
  file: File
  path?: string
  filename?: string
  chunkSize?: number
  /** Extra attempts per chunk after a failure. Offsets make a resent chunk
   * overwrite itself on the backend/ESP32 protocol; keep 0 against the
   * on-device Nim admin API, which appends blindly. */
  retries?: number
  /** The frame's storage to write into (the `storage` query parameter);
   * absent means the assets folder. */
  storage?: AssetStorageId
  /** How long one chunk may keep answering 504 before the file fails, when
   * `retries` is above 0. A 504 is the control plane saying the frame has
   * not acked the chunk YET: the cloud keeps the command queued and the next
   * request for the same offset waits for that command again rather than
   * sending the bytes twice (putAssetChunk). A slow card or a busy frame
   * takes longer than the request's 30 s, and failing the file then
   * abandoned it half-written on the frame. */
  pendingBudgetMs?: number
  onProgress?: (uploadedBytes: number) => void
  /** Called with true while a chunk is waiting on the frame (a 504 came
   * back and the chunk is being asked about again), false once it lands. */
  onWaiting?: (waiting: boolean) => void
}

const DEFAULT_PENDING_BUDGET_MS = 10 * 60 * 1000

class ChunkGapError extends Error {}

interface ChunkResponse {
  status: number
  payload: any
}

/** Raw-body POST with XHR so we get upload progress events (fetch has none).
 * Resolves for any HTTP status; rejects only on network failure. */
function postChunk(url: string, body: Blob, onProgress?: (sentBytes: number) => void): Promise<ChunkResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const requestUrl = getBasePath() && url.startsWith('/') ? `${getBasePath()}${url}` : url
    xhr.open('POST', requestUrl)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded)
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onload = () => {
      let payload: any = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        // non-JSON error bodies are fine; status carries the outcome
      }
      resolve({ status: xhr.status, payload })
    }
    xhr.send(body)
  })
}

export async function uploadFileInChunks(options: UploadFileInChunksOptions): Promise<any> {
  // A 409 means the server lost earlier bytes (device rebooted, backend
  // restarted): the whole upload restarts once under a fresh upload id.
  let restartsLeft = 1
  for (;;) {
    try {
      return await uploadOnce(options)
    } catch (error) {
      if (error instanceof ChunkGapError && restartsLeft-- > 0) {
        continue
      }
      throw error
    }
  }
}

async function uploadOnce({
  frameId,
  suffix,
  file,
  path,
  filename,
  chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
  retries = 0,
  storage,
  pendingBudgetMs = DEFAULT_PENDING_BUDGET_MS,
  onProgress,
  onWaiting,
}: UploadFileInChunksOptions): Promise<any> {
  const uploadId = secureToken(18)
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize))
  let finalPayload: any = null

  onProgress?.(0)

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * chunkSize
    const end = Math.min(file.size, start + chunkSize)
    const params = new URLSearchParams({
      upload_id: uploadId,
      filename: filename || file.name,
      chunk_index: String(chunkIndex),
      offset: String(start),
      complete: chunkIndex === totalChunks - 1 ? '1' : '0',
    })
    if (path) {
      params.set('path', path)
    }
    if (storage && storage !== DEFAULT_ASSET_STORAGE) {
      params.set('storage', storage)
    }
    const url = `${frameAssetsApiPath(frameId, suffix)}?${params.toString()}`
    const body = file.slice(start, end)

    let response: ChunkResponse | null = null
    const chunkStarted = Date.now()
    let waiting = false
    for (let attempt = 0; ; attempt++) {
      try {
        response = await postChunk(url, body, (sentBytes) => {
          onProgress?.(Math.min(end, start + sentBytes))
        })
      } catch (error) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
          continue
        }
        throw error
      }
      if (response.status === 409) {
        throw new ChunkGapError('Upload lost earlier bytes; restarting')
      }
      // Not acked yet: ask again, without spending a retry, for as long as
      // the budget allows (see pendingBudgetMs).
      if (response.status === 504 && retries > 0 && Date.now() - chunkStarted < pendingBudgetMs) {
        if (!waiting) {
          waiting = true
          onWaiting?.(true)
        }
        // The cloud's 504 comes after its own 30 s wait; a second's pause
        // keeps a proxy that answers 504 at once from turning this into a
        // tight loop.
        await new Promise((r) => setTimeout(r, 1000))
        attempt--
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
          continue
        }
        throw new Error(`Upload failed with status ${response.status}`)
      }
      break
    }
    if (waiting) {
      onWaiting?.(false)
    }

    finalPayload = response.payload
    onProgress?.(end)
  }

  return finalPayload
}

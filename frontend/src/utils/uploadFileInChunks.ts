import { apiFetch } from './apiFetch'
import { frameAssetsApiPath } from './frameAssetsApi'
import { secureToken } from './secureToken'

const DEFAULT_UPLOAD_CHUNK_SIZE = 512 * 1024

interface UploadFileInChunksOptions {
  frameId: number
  suffix: string
  file: File
  path?: string
  filename?: string
  chunkSize?: number
  onProgress?: (uploadedBytes: number) => void
}

export async function uploadFileInChunks({
  frameId,
  suffix,
  file,
  path,
  filename,
  chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
  onProgress,
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
      complete: chunkIndex === totalChunks - 1 ? '1' : '0',
    })
    if (path) {
      params.set('path', path)
    }

    const response = await apiFetch(`${frameAssetsApiPath(frameId, suffix)}?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.slice(start, end),
    })

    if (!response.ok) {
      throw new Error(`Upload failed with status ${response.status}`)
    }

    finalPayload = await response.json()
    onProgress?.(end)
  }

  return finalPayload
}

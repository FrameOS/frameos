// @vitest-environment jsdom
//
// The Assets panel's chunked upload against a frame that is slow to ack
// (frontend/src/utils/uploadFileInChunks.ts). The cloud's route answers 504
// when the frame has not acked a chunk within its 30 s; the command stays
// queued and asking again waits for that same command (putAssetChunk). An
// ESP32 writing a photo to its card took over 90 s a chunk at times
// (2026-11-28), and the two retries the panel had then failed the file and
// left it half-written on the frame. And the row thumbnails: an ESP32 is not
// asked for the thumbnail of a big file (utils/deviceThumbnails.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deviceThumbnailMaxBytes,
  ESP32_THUMBNAIL_MAX_BYTES,
  thumbnailSizeAllowed,
} from '../../../../../../frontend/src/utils/deviceThumbnails'
import { uploadFileInChunks } from '../../../../../../frontend/src/utils/uploadFileInChunks'

function fakeXhr(statuses: number[]) {
  const opened: string[] = []
  class FakeXhr {
    status = 200
    responseText = '{"pending":true}'
    upload: { onprogress?: unknown } = {}
    withCredentials = false
    onload?: () => void
    onerror?: () => void
    open(_method: string, url: string) {
      opened.push(url)
    }
    setRequestHeader() {}
    send() {
      this.status = statuses.shift() ?? 200
      this.responseText = this.status === 504 ? '{"error":"frame_unreachable"}' : '{"path":"a.jpg"}'
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  return opened
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  let result: T | undefined
  let failure: unknown
  promise.then(
    (value) => {
      done = true
      result = value
    },
    (error) => {
      done = true
      failure = error
    }
  )
  for (let i = 0; i < 100 && !done; i++) {
    await vi.advanceTimersByTimeAsync(1000)
  }
  if (failure) throw failure
  return result as T
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a chunk the frame has not acked yet', () => {
  it('is asked about again past the retries while the frame is only slow', async () => {
    vi.useFakeTimers()
    // Five 504s on the first chunk: more than the two retries ever allowed.
    const opened = fakeXhr([504, 504, 504, 504, 504, 200, 200])
    const waiting: boolean[] = []
    const file = new File(['abcdefgh'], 'a.jpg')
    const payload = await settle(
      uploadFileInChunks({
        frameId: 1,
        suffix: 'assets/upload',
        file,
        chunkSize: 4,
        retries: 2,
        onWaiting: (value) => waiting.push(value),
      })
    )
    expect(payload).toEqual({ path: 'a.jpg' })
    // The same chunk (offset 0) six times, then the second one once.
    const offsets = opened.map((url) => new URL(url, 'http://x').searchParams.get('offset'))
    expect(offsets).toEqual(['0', '0', '0', '0', '0', '0', '4'])
    expect(waiting).toEqual([true, false])
  })

  it('fails the file once the budget is spent', async () => {
    vi.useFakeTimers()
    fakeXhr(Array(50).fill(504))
    const file = new File(['abcd'], 'a.jpg')
    await expect(
      settle(
        uploadFileInChunks({
          frameId: 1,
          suffix: 'assets/upload',
          file,
          chunkSize: 4,
          retries: 2,
          pendingBudgetMs: 3000,
        })
      )
    ).rejects.toThrow('Upload failed with status 504')
  })

  it('is not asked about again where retries are off (the on-frame admin API appends)', async () => {
    const opened = fakeXhr([504])
    const file = new File(['abcd'], 'a.jpg')
    await expect(uploadFileInChunks({ frameId: 1, suffix: 'assets/upload', file, chunkSize: 4 })).rejects.toThrow(
      'Upload failed with status 504'
    )
    expect(opened).toHaveLength(1)
  })
})

describe('row thumbnails', () => {
  it('asks an ESP32 only for the thumbnails of small files', () => {
    const max = deviceThumbnailMaxBytes(true)
    expect(max).toBe(ESP32_THUMBNAIL_MAX_BYTES)
    expect(thumbnailSizeAllowed(300_000, max)).toBe(true)
    expect(thumbnailSizeAllowed(ESP32_THUMBNAIL_MAX_BYTES, max)).toBe(true)
    expect(thumbnailSizeAllowed(9_060_723, max)).toBe(false)
    expect(thumbnailSizeAllowed(undefined, max)).toBe(false)
  })

  it('asks any other frame for every image', () => {
    const max = deviceThumbnailMaxBytes(false)
    expect(max).toBeUndefined()
    expect(thumbnailSizeAllowed(9_060_723, max)).toBe(true)
    expect(thumbnailSizeAllowed(undefined, max)).toBe(true)
  })
})

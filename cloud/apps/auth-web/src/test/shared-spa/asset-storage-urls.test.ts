// @vitest-environment jsdom
//
// The storage URLs of a frame's assets (frontend/src/utils/frameAssetsApi.ts):
// every asset call takes the storage shown as the `storage` query parameter,
// left off for the assets folder so a one-storage frame's URLs are what they
// always were. The panel itself: asset-storages.test.tsx.
import { describe, expect, it, vi } from 'vitest'

import {
  assetStorageAfterListing,
  assetStoragesFromListing,
  frameAssetUrl,
  withAssetStorage,
} from '../../../../../../frontend/src/utils/frameAssetsApi'
import { uploadFileInChunks } from '../../../../../../frontend/src/utils/uploadFileInChunks'

const TWO_STORAGES = [
  { id: 'assets', name: 'TF card' },
  { id: 'internal', name: 'Internal storage' },
]

describe('the storage URL helpers', () => {
  it('adds the parameter for a storage other than the assets folder only', () => {
    expect(withAssetStorage('/api/frames/1/assets/mkdir', 'internal')).toBe(
      '/api/frames/1/assets/mkdir?storage=internal'
    )
    expect(withAssetStorage('/api/frames/1/assets?folder=', 'internal')).toBe(
      '/api/frames/1/assets?folder=&storage=internal'
    )
    expect(withAssetStorage('/api/frames/1/assets?folder=', 'assets')).toBe('/api/frames/1/assets?folder=')
    expect(withAssetStorage('/api/frames/1/assets', undefined)).toBe('/api/frames/1/assets')
  })

  it('puts it on the file, thumbnail and download URLs', () => {
    const thumb = new URL(frameAssetUrl(1, 'a.jpg', { thumb: true, storage: 'internal' }), 'http://x')
    expect(thumb.pathname).toBe('/api/frames/1/asset')
    expect(thumb.searchParams.get('storage')).toBe('internal')
    expect(thumb.searchParams.get('thumb')).toBe('1')
    const download = new URL(frameAssetUrl(1, 'a.txt', { mode: 'download', storage: 'internal' }), 'http://x')
    expect(download.searchParams.get('storage')).toBe('internal')
    expect(download.searchParams.get('mode')).toBe('download')
    expect(new URL(frameAssetUrl(1, 'a.jpg', true), 'http://x').searchParams.has('storage')).toBe(false)
    expect(new URL(frameAssetUrl(1, 'a.jpg', { storage: 'assets' }), 'http://x').searchParams.has('storage')).toBe(
      false
    )
  })

  it("reads the listing's storages, and none when it says nothing", () => {
    expect(assetStoragesFromListing(undefined)).toBeNull()
    expect(assetStoragesFromListing(TWO_STORAGES)).toEqual(TWO_STORAGES)
    expect(
      assetStoragesFromListing([{ id: 'internal', name: '' }, { id: 'cloud', name: '?' }, { id: 'internal' }, null])
    ).toEqual([{ id: 'internal', name: 'internal' }])
  })

  it('keeps the storage shown while the frame has it, else shows the first it lists', () => {
    expect(assetStorageAfterListing('internal', TWO_STORAGES as { id: 'assets' | 'internal'; name: string }[])).toBe(
      'internal'
    )
    expect(assetStorageAfterListing('internal', [{ id: 'assets', name: 'Internal storage' }])).toBe('assets')
    expect(assetStorageAfterListing('assets', [{ id: 'internal', name: 'Internal storage' }])).toBe('internal')
    expect(assetStorageAfterListing('internal', null)).toBe('assets')
    expect(assetStorageAfterListing('internal', [])).toBe('assets')
  })

  it('sends the storage with every chunk of a chunked upload', async () => {
    const opened: string[] = []
    class FakeXhr {
      status = 200
      responseText = '{"path":"a.txt"}'
      upload: { onprogress?: unknown } = {}
      withCredentials = false
      onload?: () => void
      onerror?: () => void
      open(_method: string, url: string) {
        opened.push(url)
      }
      setRequestHeader() {}
      send() {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const file = new File(['abcdef'], 'a.txt')
    await uploadFileInChunks({
      frameId: 1,
      suffix: 'assets/upload',
      file,
      path: 'books',
      chunkSize: 4,
      storage: 'internal',
    })
    await uploadFileInChunks({ frameId: 1, suffix: 'assets/upload', file, chunkSize: 4 })
    vi.unstubAllGlobals()
    expect(opened).toHaveLength(4)
    for (const url of opened.slice(0, 2)) {
      expect(new URL(url, 'http://x').searchParams.get('storage')).toBe('internal')
    }
    for (const url of opened.slice(2)) {
      expect(new URL(url, 'http://x').searchParams.has('storage')).toBe(false)
    }
  })
})

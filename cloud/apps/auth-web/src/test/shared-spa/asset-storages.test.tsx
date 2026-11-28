// @vitest-environment jsdom
//
// An ESP32 with a TF card also keeps files in its internal flash storage, and
// the Assets panel browses both (the URL helpers: asset-storage-urls.test.ts): the listing names the places the frame has
// (`storages: [{id, name}]`, by the frame's own names) and every asset call
// the panel makes takes the one shown as the `storage` query parameter
// (absent = the assets folder). A frame with one storage, or a plane too old
// to say, sees exactly what it always did: no switch, no parameter.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>())
vi.mock('../../../../../../frontend/src/utils/apiFetch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init) }
})

// Both upload shapes go through XHR helpers; the logic's half is what URL and
// storage it hands them (uploadFileInChunks' own URL is pinned below).
const chunkedUploadMock = vi.hoisted(() =>
  vi.fn(async (options: { path?: string; filename?: string }) => ({
    path: `${options.path ? `${options.path}/` : ''}${options.filename}`,
    size: 3,
    mtime: 1,
  }))
)
const formUploadMock = vi.hoisted(() =>
  vi.fn(async (_options: { url: string; formData: FormData }) => ({
    path: '/srv/assets/photo.jpg',
    size: 3,
    mtime: 1,
  }))
)
vi.mock('../../../../../../frontend/src/utils/uploadFileInChunks', () => ({
  uploadFileInChunks: (options: { path?: string; filename?: string }) => chunkedUploadMock(options),
}))
vi.mock('../../../../../../frontend/src/utils/uploadFormDataWithProgress', () => ({
  uploadFormDataWithProgress: (options: { url: string; formData: FormData }) => formUploadMock(options),
}))

import { initKea } from '../../../../../../frontend/src/initKea'
import { framesModel } from '../../../../../../frontend/src/models/framesModel'
import { BindLogic } from '../../../../../../frontend/node_modules/kea'
import { frameLogic } from '../../../../../../frontend/src/scenes/frame/frameLogic'
import { Assets, AssetStorageSwitch } from '../../../../../../frontend/src/scenes/frame/panels/Assets/Assets'
import {
  assetFolderExpansionPath,
  assetFolderFromExpansionPath,
  assetStorageRootPath,
  assetsLogic,
  imageSceneName,
} from '../../../../../../frontend/src/scenes/frame/panels/Assets/assetsLogic'
import type { FrameType } from '../../../../../../frontend/src/types'

type TestWindow = Window & {
  FRAMEOS_APP_CONFIG?: Record<string, unknown>
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean
}
const testWindow = window as TestWindow

const TWO_STORAGES = [
  { id: 'assets', name: 'TF card' },
  { id: 'internal', name: 'Internal storage' },
]

let listings: Record<string, Record<string, unknown>>

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function calls(method: string, prefix = '/api/frames/1/assets'): string[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => (init?.method ?? 'GET') === method && requestUrl(input).startsWith(prefix))
    .map(([input]) => requestUrl(input))
}

function makeFrame(overrides: Partial<FrameType> = {}): FrameType {
  return {
    id: 1,
    project_id: 1,
    name: 'Sticky',
    frame_host: '10.0.0.5',
    frame_port: 8787,
    frame_access_key: '',
    frame_access: 'private',
    ssh_port: 22,
    server_port: 8989,
    status: 'ready',
    interval: 300,
    metrics_interval: 60,
    scaling_mode: 'contain',
    device: 'web_only',
    assets_path: '/srv/assets',
    ...overrides,
  } as unknown as FrameType
}

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true
  listings = {
    assets: {
      assets: [{ path: '/srv/assets/card.jpg', size: 1, mtime: 1 }],
      folder: '',
      storages: TWO_STORAGES,
      storage: 'assets',
    },
    internal: {
      assets: [{ path: '/srv/assets/flash.jpg', size: 1, mtime: 1 }],
      folder: '',
      storages: TWO_STORAGES,
      storage: 'internal',
    },
  }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET'
    const url = new URL(requestUrl(input), 'http://frameos.test')
    if (method === 'GET' && url.pathname === '/api/frames/1/assets') {
      const storage = url.searchParams.get('storage') ?? 'assets'
      const listing = listings[storage]
      return listing ? Response.json(listing) : Response.json({ detail: 'storage_unavailable' }, { status: 404 })
    }
    if (method === 'POST' && url.pathname.startsWith('/api/frames/1/assets/')) {
      return Response.json({ message: 'ok' })
    }
    return Response.json({}, { status: 404 })
  })
  chunkedUploadMock.mockClear()
  formUploadMock.mockClear()
  initKea()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete testWindow.FRAMEOS_APP_CONFIG
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND
})

function mountAssets(frame: FrameType = makeFrame(), storage?: 'assets' | 'internal') {
  framesModel.mount()
  framesModel.actions.loadFramesSuccess({ [String(frame.id)]: frame } as Record<string, FrameType>)
  const logic = assetsLogic(storage ? { frameId: frame.id, storage } : { frameId: frame.id })
  logic.mount()
  return logic
}

describe('folders and roots per storage', () => {
  it("opens the two trees' folders apart", () => {
    expect(assetFolderExpansionPath('assets', 'books')).toBe('books')
    expect(assetFolderExpansionPath('internal', 'books')).toBe('internal:books')
    expect(assetFolderFromExpansionPath('assets', 'books')).toBe('books')
    expect(assetFolderFromExpansionPath('assets', 'internal:books')).toBeNull()
    expect(assetFolderFromExpansionPath('internal', 'internal:books')).toBe('books')
    expect(assetFolderFromExpansionPath('internal', 'books')).toBeNull()
    expect(assetStorageRootPath('internal', '/srv/assets')).toBe('/srv/internal')
    expect(assetStorageRootPath('assets', '/media/card')).toBe('/media/card')
  })
})

describe("the Assets panel's storage", () => {
  it('lists the assets folder first, with no parameter, and offers the switch for two storages', async () => {
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.storages).toEqual(TWO_STORAGES))
    expect(calls('GET')).toEqual(['/api/frames/1/assets?folder='])
    expect(logic.values.storage).toBe('assets')
    expect(logic.values.showStorageSwitch).toBe(true)
    expect(logic.values.assets.map((asset) => asset.path)).toEqual(['/srv/assets/card.jpg'])
  })

  it('lists, writes and links the internal storage once it is picked', async () => {
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.showStorageSwitch).toBe(true))
    // A folder of the card left open does not open the same name in the flash.
    logic.actions.setStorage('internal')
    expect(logic.values.assets).toEqual([])
    await waitFor(() => expect(logic.values.assets.map((asset) => asset.path)).toEqual(['/srv/assets/flash.jpg']))
    expect(calls('GET').at(-1)).toBe('/api/frames/1/assets?folder=&storage=internal')
    expect(logic.values.storageRootPath).toBe('/srv/internal')
    expect(logic.values.assetTree.name).toBe('/srv/internal')

    logic.actions.createFolder('books')
    logic.actions.deleteAsset('flash.jpg')
    logic.actions.renameAsset('old.txt', 'new.txt')
    await waitFor(() => expect(calls('POST')).toHaveLength(3))
    expect(calls('POST')).toEqual([
      '/api/frames/1/assets/mkdir?storage=internal',
      '/api/frames/1/assets/delete?storage=internal',
      '/api/frames/1/assets/rename?storage=internal',
    ])
    // The folder listing after mkdir asks the same storage.
    await waitFor(() => expect(calls('GET')).toContain('/api/frames/1/assets?folder=&storage=internal'))
    logic.actions.loadFolder('books')
    await waitFor(() => expect(calls('GET')).toContain('/api/frames/1/assets?folder=books&storage=internal'))
  })

  it('syncs fonts into the assets folder whichever storage is shown, and says so', async () => {
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.showStorageSwitch).toBe(true))
    expect(logic.values.fontSyncElsewhere).toBe(false)
    logic.actions.setStorage('internal')
    expect(logic.values.fontSyncElsewhere).toBe(true)
    logic.actions.syncAssets()
    await waitFor(() => expect(calls('POST')).toEqual(['/api/frames/1/assets/sync']))
  })

  it('shows the only storage a frame lists, the internal one of an ESP32 with no card', async () => {
    const onlyInternal = [{ id: 'internal', name: 'Internal storage' }]
    listings.assets = { ...listings.assets, storages: onlyInternal }
    listings.internal = { ...listings.internal, storages: onlyInternal }
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.storage).toBe('internal'))
    await waitFor(() => expect(logic.values.assets.map((asset) => asset.path)).toEqual(['/srv/assets/flash.jpg']))
    expect(calls('GET')).toEqual(['/api/frames/1/assets?folder=', '/api/frames/1/assets?folder=&storage=internal'])
    expect(logic.values.showStorageSwitch).toBe(false)
    // Its assets folder is the same flash: fonts sync as ever.
    expect(logic.values.fontSyncElsewhere).toBe(false)
  })

  it('reads the mount flag at the top level, and in the older nested shape', async () => {
    listings.assets = { assets: [], folder: '', storage: 'assets', storages: TWO_STORAGES, mounted: false }
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.storageUnmounted).toBe(true))
    initKea()
    listings.assets = { assets: [], folder: '', storage: { mounted: false } }
    const older = mountAssets()
    await waitFor(() => expect(older.values.storageUnmounted).toBe(true))
    expect(older.values.storages).toEqual([])
  })

  it('uploads to the storage shown, in both shapes', async () => {
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.showStorageSwitch).toBe(true))
    logic.actions.setStorage('internal')
    logic.actions.uploadDroppedFiles('', [new File(['abc'], 'photo.jpg')])
    await waitFor(() => expect(formUploadMock).toHaveBeenCalledTimes(1))
    expect(formUploadMock.mock.calls[0]?.[0].url).toBe('/api/frames/1/assets/upload?storage=internal')

    initKea()
    const embedded = mountAssets(makeFrame({ mode: 'embedded' } as Partial<FrameType>))
    await waitFor(() => expect(embedded.values.showStorageSwitch).toBe(true))
    embedded.actions.setStorage('internal')
    embedded.actions.uploadDroppedFiles('books', [new File(['abc'], 'a.epub')])
    await waitFor(() => expect(chunkedUploadMock).toHaveBeenCalledTimes(1))
    expect(chunkedUploadMock.mock.calls[0]?.[0]).toMatchObject({
      suffix: 'assets/upload',
      path: 'books',
      storage: 'internal',
    })
  })

  it('sends no parameter for the assets folder', async () => {
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.showStorageSwitch).toBe(true))
    logic.actions.deleteAsset('card.jpg')
    logic.actions.uploadDroppedFiles('', [new File(['abc'], 'photo.jpg')])
    await waitFor(() => expect(formUploadMock).toHaveBeenCalledTimes(1))
    expect(formUploadMock.mock.calls[0]?.[0].url).toBe('/api/frames/1/assets/upload')
    await waitFor(() => expect(calls('POST')).toEqual(['/api/frames/1/assets/delete']))
  })

  it('shows one storage, and no switch, when the listing says nothing of storages', async () => {
    listings.assets = { assets: [{ path: '/srv/assets/card.jpg', size: 1, mtime: 1 }], folder: '' }
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.assets).toHaveLength(1))
    expect(logic.values.storages).toEqual([])
    expect(logic.values.showStorageSwitch).toBe(false)
    expect(logic.values.storage).toBe('assets')
  })

  it('goes back to the assets folder when the frame stops listing the storage shown', async () => {
    const logic = mountAssets()
    await waitFor(() => expect(logic.values.showStorageSwitch).toBe(true))
    logic.actions.setStorage('internal')
    await waitFor(() => expect(logic.values.assets).toHaveLength(1))
    listings.internal = { ...listings.internal, storages: [{ id: 'assets', name: 'Internal storage' }] }
    listings.assets = { ...listings.assets, storages: [{ id: 'assets', name: 'Internal storage' }] }
    logic.actions.refreshAssets()
    await waitFor(() => expect(logic.values.storage).toBe('assets'))
    await waitFor(() => expect(logic.values.assets.map((asset) => asset.path)).toEqual(['/srv/assets/card.jpg']))
    expect(logic.values.showStorageSwitch).toBe(false)
  })

  it("keeps a path picker's logic on the assets folder", async () => {
    const pinned = mountAssets(makeFrame(), 'assets')
    await waitFor(() => expect(pinned.values.storages).toEqual(TWO_STORAGES))
    expect(pinned.values.showStorageSwitch).toBe(false)
    pinned.actions.setStorage('internal')
    expect(pinned.values.storage).toBe('assets')
    // The panel's own logic is a different one.
    expect(assetsLogic({ frameId: 1 }).isMounted()).toBe(false)
  })
})

describe('an upload the frame stores under another name', () => {
  // The frame (and the backend) store "2024-10-27 Liermolen.jpg" as
  // "2024-10-27_Liermolen.jpg": the row the upload showed while it ran goes
  // when the stored one comes back, where it used to stay as a duplicate with
  // a spinner until the folder was loaded again (a user's 20 photos, 2026-11-28).
  it('replaces its row with the stored one', async () => {
    const logic = mountAssets(makeFrame({ mode: 'embedded' } as Partial<FrameType>))
    await waitFor(() => expect(logic.values.showStorageSwitch).toBe(true))
    chunkedUploadMock.mockImplementationOnce(async () => ({
      path: 'portrait/2024-10-27_Liermolen.jpg',
      size: 3,
      mtime: 1,
    }))
    logic.actions.uploadDroppedFiles('portrait', [new File(['abc'], '2024-10-27 Liermolen.jpg')])
    await waitFor(() => expect(chunkedUploadMock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(logic.values.assets.map((asset) => asset.path).filter((path) => path.includes('Liermolen'))).toEqual([
        '/srv/assets/portrait/2024-10-27_Liermolen.jpg',
      ])
    )
  })
})

describe('an image installed as a scene', () => {
  it('is named after the image or the folder', () => {
    expect(imageSceneName({ imageFolder: '/srv/assets/portrait', filename: '2024-10-27_Liermolen.jpg' })).toBe(
      '2024-10-27_Liermolen'
    )
    expect(imageSceneName({ imageFolder: '/srv/assets/portrait/' })).toBe('portrait')
    expect(imageSceneName({ imageFolder: '/srv/assets', name: 'Slideshow' })).toBe('Slideshow')
  })
})

describe('the switch in the panel', () => {
  function renderPanel() {
    // The row menus portal into #popper; thumbnails load once in view.
    document.body.innerHTML = '<div id="popper"></div>'
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        callback: (entries: { isIntersecting: boolean }[]) => void
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          this.callback = callback
        }
        observe() {
          this.callback([{ isIntersecting: true }])
        }
        unobserve() {}
        disconnect() {}
      }
    )
    const frame = makeFrame()
    framesModel.mount()
    framesModel.actions.loadFramesSuccess({ [String(frame.id)]: frame } as Record<string, FrameType>)
    return render(
      <BindLogic logic={frameLogic} props={{ frameId: frame.id }}>
        <Assets />
      </BindLogic>
    )
  }

  it('is shown above the tree for a frame with two storages, and switches the listing', async () => {
    const { container } = renderPanel()
    await screen.findByText('card.jpg')
    expect(screen.getByRole('tab', { name: 'TF card' }).getAttribute('aria-selected')).toBe('true')
    const thumb = async () => {
      await waitFor(() => expect(container.querySelector('.asset-file-thumb img')).not.toBeNull())
      return new URL(container.querySelector('.asset-file-thumb img')!.getAttribute('src')!, 'http://x')
    }
    expect((await thumb()).searchParams.has('storage')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: 'Internal storage' }))
    await screen.findByText('flash.jpg')
    expect(screen.queryByText('card.jpg')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Internal storage' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByText('/srv/internal').length).toBeGreaterThan(0)
    const internalThumb = await thumb()
    expect(internalThumb.searchParams.get('path')).toBe('flash.jpg')
    expect(internalThumb.searchParams.get('storage')).toBe('internal')
  })

  it('is not shown for a frame with one storage', async () => {
    listings.assets = { ...listings.assets, storages: [{ id: 'assets', name: 'Internal storage' }] }
    renderPanel()
    await screen.findByText('card.jpg')
    expect(screen.queryByRole('tablist', { name: 'Storage' })).toBeNull()
  })

  it('is not shown when the listing says nothing of storages', async () => {
    listings.assets = { assets: [{ path: '/srv/assets/card.jpg', size: 1, mtime: 1 }], folder: '' }
    renderPanel()
    await screen.findByText('card.jpg')
    expect(screen.queryByRole('tablist', { name: 'Storage' })).toBeNull()
  })
})

describe('AssetStorageSwitch', () => {
  it('names the storages as the frame does and picks one', () => {
    const onSelect = vi.fn()
    render(<AssetStorageSwitch storages={TWO_STORAGES as never} storage="assets" onSelect={onSelect} />)
    expect(screen.getByRole('tablist', { name: 'Storage' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'TF card' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Internal storage' }))
    expect(onSelect).toHaveBeenCalledWith('internal')
  })
})

import { compareImagePaths, get, isImage, resolveFolder, shuffled } from './app'

// A folder of files by their path in the storage, and their sizes.
function folder(files: Record<string, number>, internal: Record<string, number> = {}) {
  const pick = (options?: { storage?: string }) => (options?.storage === 'internal' ? internal : files)
  mock.listAssets((dir?: string, options?: { storage?: 'assets' | 'internal' }) => {
    const prefix = dir ? dir + '/' : ''
    return Object.keys(pick(options))
      .filter((path) => path.startsWith(prefix))
      .sort()
  })
  mock.assetExists((path: string, options?: { storage?: 'assets' | 'internal' }) => path in pick(options))
  mock.assetSize((path: string, options?: { storage?: 'assets' | 'internal' }) => pick(options)[path] ?? 0)
  return mock.loadAssetImage((path: string, options?: any) => ({
    ...mock.image({ width: 4, height: 3 }).image,
    ...(options?.exif ? { exif: { make: 'Canon' }, exifSummary: 'Canon' } : {}),
    path,
  }))
}

const render = (extra: Record<string, any> = {}) => makeContext({ event: 'render', ...extra })

describe('localImage', () => {
  it('goes through a folder by name, ignoring case, and keeps the counter in state', () => {
    const load = folder({ 'zeta.jpg': 10, 'Alpha.jpg': 10, 'middle.png': 10 })
    const app = makeApp({
      config: { path: '/srv/assets', order: 'alphabetical', counterStateKey: 'counter', metadataStateKey: 'meta' },
      state: { counter: 0 },
    })
    const names = [0, 1, 2, 3].map(() => {
      get(app, render())
      return app.state.meta.filename
    })
    expect(names).toEqual(['Alpha.jpg', 'middle.png', 'zeta.jpg', 'Alpha.jpg'])
    expect(app.state.counter).toBe(1)
    expect(load.calls[0][0]).toBe('Alpha.jpg')
    expect(app.state.meta).toMatchObject({ path: '/srv/assets/Alpha.jpg', index: 0, total: 3, width: 4, height: 3 })
    expect(app.state.meta.exif).toEqual({ make: 'Canon' })
    expect(app.state.meta.exifSummary).toBe('Canon')
  })

  it('skips what is not an image, empty files, and QOI and PPM on a device', () => {
    folder({ 'a.jpg': 10, 'b.txt': 10, 'empty.bmp': 0, 'c.qoi': 10, 'sub/d.PPM': 10 })
    const host = makeApp({ config: { path: '', order: 'alphabetical', metadataStateKey: 'meta' } })
    get(host, render())
    expect(host.state.meta.total).toBe(3)
    const device = makeApp({
      config: { path: '', order: 'alphabetical', metadataStateKey: 'meta' },
      frame: { embedded: true },
    })
    get(device, render())
    expect(device.state.meta.total).toBe(1)
  })

  it('reads a subfolder and /srv/internal, and refuses a path outside the frame’s files', () => {
    const load = folder({ 'trips/x.jpg': 10, 'y.jpg': 10 }, { 'pics/z.jpg': 10 })
    const sub = makeApp({ config: { path: '/srv/assets/trips/', metadataStateKey: 'meta' } })
    get(sub, render())
    expect(sub.state.meta).toMatchObject({ filename: 'x.jpg', path: '/srv/assets/trips/x.jpg', total: 1 })
    expect(load.calls[0][0]).toBe('trips/x.jpg')
    const internal = makeApp({ config: { path: '/srv/internal/pics', metadataStateKey: 'meta' } })
    get(internal, render())
    expect(load.calls[1]).toEqual(['pics/z.jpg', { storage: 'internal', exif: true }])
    const error = mock.frameos('error')
    const outside = makeApp({ config: { path: '/home/pi/Pictures' } })
    const shown = get(outside, render()) as { svg: string }
    expect(error.calls[0][0]).toBe("/home/pi/Pictures is outside the frame's files: put the photos in /srv/assets")
    expect(shown.svg).toContain('/home/pi/Pictures is outside')
  })

  it('shows one file alone when the path names it', () => {
    folder({ 'only.jpg': 10, 'other.jpg': 10 })
    const app = makeApp({ config: { path: '/srv/assets/only.jpg', metadataStateKey: 'meta' } })
    get(app, render())
    expect(app.state.meta).toMatchObject({ filename: '', path: '/srv/assets/only.jpg', total: 1 })
  })

  it('filters by name, ignoring case, and starts over when the search changes', () => {
    folder({ 'SunSet.jpg': 10, 'Ocean.jpg': 10 })
    const app = makeApp({ config: { path: '', search: 'sunset', metadataStateKey: 'meta' } })
    get(app, render())
    expect(app.state.meta.filename).toBe('SunSet.jpg')
    app.config.search = 'OCEAN'
    get(app, render())
    expect(app.state.meta.filename).toBe('Ocean.jpg')
  })

  it('says why there is nothing to show, in a picture the node cache keeps', () => {
    folder({ 'a.jpg': 10 })
    const error = mock.frameos('error')
    const noMatch = get(makeApp({ config: { path: '', search: 'none' } }), render()) as { svg: string }
    expect(error.calls[0][0]).toBe('No images matching the search query "none" found in the folder: ')
    expect(noMatch.svg).toContain('No images matching the search query &quot;none&quot;')
    const empty = get(
      makeApp({ config: { path: '/srv/assets/missing' } }),
      render({ imageWidth: 800, imageHeight: 480 })
    )
    expect(error.calls[1][0]).toBe('No images found in the folder: /srv/assets/missing')
    expect((empty as { width: number }).width).toBe(800)
    // On a device with no target: a fraction of the canvas, under 512 KB.
    const device = makeApp({ config: { path: '/srv/assets/missing' }, frame: { embedded: true } })
    const small = get(device, render({ imageWidth: 1848, imageHeight: 1179 })) as { width: number; height: number }
    expect(small.width * small.height * 4).toBeLessThanOrEqual(512 * 1024)
    expect([small.width, small.height]).toEqual([369, 235])
  })

  it('repeats the photo when the cache remakes it or the scene repaints, without stepping on', () => {
    const load = folder({ 'a.jpg': 10, 'b.jpg': 10 })
    const app = makeApp({
      config: { path: '', order: 'alphabetical', counterStateKey: 'counter', metadataStateKey: 'meta' },
      state: { counter: 0 },
    })
    get(app, render())
    get(app, render({ remakingCachedValue: true }))
    get(app, render({ repainting: true }))
    expect(load.calls.map((call) => call[0])).toEqual(['a.jpg', 'a.jpg', 'a.jpg'])
    // No EXIF read and no new metadata for a repeat.
    expect(load.calls[1][1]).toEqual({})
    expect(app.state.counter).toBe(1)
    get(app, render())
    expect(app.state.meta.filename).toBe('b.jpg')
  })

  it('shuffles once and keeps that order until the folder changes', () => {
    const files: Record<string, number> = {}
    for (let i = 0; i < 12; i++) files[`p${i}.jpg`] = 10
    folder(files)
    const app = makeApp({ config: { path: '', order: 'random', metadataStateKey: 'meta' } })
    const seen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      get(app, render())
      seen.add(app.state.meta.filename)
    }
    // Every photo once before any repeats.
    expect(seen.size).toBe(12)
  })

  it('has the helpers the built-in app had', () => {
    expect(isImage('x.JPEG', true)).toBe(true)
    expect(isImage('x.ppm', true)).toBe(false)
    expect(isImage('x.ppm', false)).toBe(true)
    expect(['b', 'B', 'a'].sort(compareImagePaths)).toEqual(['a', 'B', 'b'])
    expect(resolveFolder('', '/srv/assets')).toEqual({ storage: 'assets', dir: '' })
    expect(resolveFolder('/srv/assets/../etc', '/srv/assets')).toBeNull()
    expect(resolveFolder('/srv/assetsx', '/srv/assets')).toBeNull()
    // A working-directory folder, with or without its "./".
    expect(resolveFolder('./tmp/assets/a.png', 'tmp/assets')).toEqual({ storage: 'assets', dir: 'a.png' })
    expect(resolveFolder('tmp/assets/a.png', './tmp/assets/')).toEqual({ storage: 'assets', dir: 'a.png' })
    expect(shuffled(['a', 'b', 'c', 'd'], 7)).toEqual(shuffled(['a', 'b', 'c', 'd'], 7))
  })
})

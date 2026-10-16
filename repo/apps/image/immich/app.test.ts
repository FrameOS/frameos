import { get } from './app'

const settings = { immich: { url: 'https://immich.local/', apiKey: 'key' } }
const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'IMAGE',
  originalFileName: `${id}.jpg`,
  isFavorite: false,
  exifInfo: { make: 'Canon', iso: 100, model: null },
  people: [{ name: 'Ann' }, { name: '' }],
  ...extra,
})

function immich(routes: Record<string, (url: string, options: any) => any>) {
  return mock.httpRequest((url: string, options: any) => {
    for (const [prefix, reply] of Object.entries(routes)) {
      if (url.startsWith(`https://immich.local${prefix}`)) return reply(url, options)
    }
    return mock.response(404, '')
  })
}

describe('immich', () => {
  it('picks a random image and downloads its preview with the key', () => {
    const http = immich({ '/api/search/random': () => mock.json([asset('a1')]) })
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ settings, config: { mode: 'random', metadataStateKey: 'photo', saveAssets: 'auto', previewSize: 'preview' } })
    expect(get(app)).toMatchObject({ __frameosType: 'image' })
    expect(http.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'x-api-key': 'key' }, timeoutMs: 30000 })
    expect(JSON.parse(http.calls[0][1].body)).toEqual({ size: 1, type: 'IMAGE', withExif: true, withPeople: true })
    expect(fetchImage).toHaveBeenCalledWith('https://immich.local/api/assets/a1/thumbnail?size=preview', {
      headers: { 'x-api-key': 'key' },
      saveAsset: { name: 'a1', extension: '.jpg', mode: 'auto' },
    })
    expect(app.state.photo).toEqual({ source: 'immich', id: 'a1', originalFileName: 'a1.jpg', make: 'Canon', iso: 100, people: ['Ann'] })
  })

  it('filters by person or favorites, and asks for the original when wanted', () => {
    const http = immich({ '/api/search/random': () => mock.json([asset('b2', { originalFileName: 'IMG_1.HEIC' })]) })
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { mode: 'random', personId: ' p1 ', previewSize: 'fullsize', saveAssets: 'always' } }))
    expect(JSON.parse(http.calls[0][1].body)).toMatchObject({ personIds: ['p1'] })
    expect(fetchImage.calls[0][0]).toBe('https://immich.local/api/assets/b2/original')
    expect(fetchImage.calls[0][1].saveAsset).toEqual({ name: 'IMG_1', extension: '.heic', mode: 'always' })
    get(makeApp({ settings, config: { mode: 'favorites', saveAssets: 'never' } }))
    expect(JSON.parse(http.calls[1][1].body)).toMatchObject({ isFavorite: true })
    expect(fetchImage.calls[1][1].saveAsset).toBeUndefined()
  })

  it('falls back to /api/assets/random on an old server', () => {
    const http = immich({
      '/api/search/random': () => mock.response(404, ''),
      '/api/assets/random': () => mock.json([asset('c3', { isFavorite: true }), asset('c4'), { id: 'v', type: 'VIDEO' }]),
    })
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { mode: 'favorites' } }))
    expect(http.calls[1][0]).toBe('https://immich.local/api/assets/random?count=20')
    expect(fetchImage.calls[0][0]).toContain('/api/assets/c3/')
  })

  it('searches an album whole on Immich 3.2, and walks the timeline before it', () => {
    const search = immich({
      '/api/server/version': () => mock.json({ major: 3, minor: 2 }),
      '/api/search/random': () => mock.json([asset('d1')]),
    })
    mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { mode: 'album', albumId: ' alb ' } }))
    expect(JSON.parse(search.calls[1][1].body)).toEqual({
      size: 1,
      withExif: true,
      withPeople: true,
      filter: { type: { eq: 'IMAGE' }, albumIds: { any: ['alb'] } },
    })
    const timeline = immich({
      '/api/server/version': () => mock.json({ major: 1, minor: 140 }),
      '/api/timeline/buckets': () => mock.json([{ timeBucket: '2026-01', count: 2 }]),
      '/api/timeline/bucket': () => mock.json({ id: ['e1', 'e2'], isImage: [true, false] }),
      '/api/assets/e1': () => mock.json(asset('e1')),
    })
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { mode: 'album', albumId: 'alb' } }))
    expect(timeline.calls.map((call) => call[0])).toEqual([
      'https://immich.local/api/server/version',
      'https://immich.local/api/timeline/buckets?albumId=alb',
      'https://immich.local/api/timeline/bucket?albumId=alb&timeBucket=2026-01',
      'https://immich.local/api/assets/e1',
    ])
    expect(fetchImage.calls[0][0]).toContain('/api/assets/e1/')
  })

  it("shows today's memories, or a random photo when there are none", () => {
    const http = immich({ '/api/memories': () => mock.json([{ assets: [asset('m1')] }]) })
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { mode: 'memories' } }))
    expect(http.calls[0][0]).toMatch(/\/api\/memories\?for=\d{4}-\d{2}-\d{2}$/)
    expect(fetchImage.calls[0][0]).toContain('/api/assets/m1/')
    immich({ '/api/memories': () => mock.response(404, ''), '/api/search/random': () => mock.json([asset('r1')]) })
    const log = mock.log()
    get(makeApp({ settings, config: { mode: 'memories' } }))
    expect(log.calls[0][0]).toContain('No Immich memories for today')
  })

  it('names what went wrong', () => {
    expect(() => get(makeApp({ settings: {}, config: { mode: 'random' } }))).toThrow('Immich server URL')
    expect(() => get(makeApp({ settings: { immich: { url: 'x' } }, config: { mode: 'random' } }))).toThrow('Immich API key')
    expect(() => get(makeApp({ settings, config: { mode: 'album', albumId: '' } }))).toThrow('Please provide an album ID')
    immich({ '/api/search/random': () => mock.response(401, { message: 'Invalid API key' }) })
    expect(() => get(makeApp({ settings, config: { mode: 'random' } }))).toThrow('HTTP 401: Invalid API key')
    immich({ '/api/search/random': () => mock.json([]) })
    expect(() => get(makeApp({ settings, config: { mode: 'random' } }))).toThrow('Immich returned no image assets.')
    immich({ '/api/search/random': () => mock.json([asset('z')]) })
    mock.fetchImage(() => ({ image: null, error: 'decode' }))
    expect(() => get(makeApp({ settings, config: { mode: 'random' } }))).toThrow('Error fetching image from Immich: decode')
  })
})

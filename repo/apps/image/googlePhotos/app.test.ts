import { extractPhotoPaths, get, sizedPhotoUrl, wrapIndex } from './app'

const HOST = 'https://lh3.googleusercontent.com/'
const long = (n: number) => 'pw/' + 'x'.repeat(70) + n
const page = [
  `..."${HOST}${long(1)}=w600-h400"...`,
  `["${HOST}${long(2)}\\u003dw100",` + `"${HOST}${long(1)}=w1"]`,
  `"${HOST}short=w1"`,
]
const config = {
  shareUrl: 'https://photos.app.goo.gl/abc',
  mode: 'random',
  counterStateKey: '',
  metadataStateKey: '',
  fitMode: 'cover',
  saveAssets: 'auto',
  cacheAlbumSeconds: 3600,
}

describe('googlePhotos helpers', () => {
  it('extracts each photo path once, decoded, and only the long album ones', () => {
    expect(extractPhotoPaths(page)).toEqual([long(1), long(2)])
    expect(extractPhotoPaths(page.join(''))).toEqual([long(1), long(2)])
  })
  it('sizes a photo url and wraps a counter', () => {
    expect(sizedPhotoUrl(HOST + 'p', 300, 200, 'cover')).toBe(`${HOST}p=w300-h200-c`)
    expect(sizedPhotoUrl(HOST + 'p', 300, 200, 'contain')).toBe(`${HOST}p=w300-h200-no`)
    expect(wrapIndex(5, 3)).toBe(2)
    expect(wrapIndex(-1, 3)).toBe(2)
    expect(wrapIndex(7, 0)).toBe(0)
  })
})

describe('googlePhotos', () => {
  it('scrapes the album page once, then plays the photos in order', () => {
    const http = mock.httpRequest(() => ({ status: 200, found: page }))
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { ...config, mode: 'sequential', counterStateKey: 'photo', metadataStateKey: 'meta' } })
    get(app, makeContext())
    expect(http).toHaveBeenCalledTimes(1)
    expect(http.calls[0][1]).toMatchObject({ find: HOST, findLength: 400, timeoutMs: 60000 })
    expect(fetchImage.calls[0][0]).toBe(`${HOST}${long(1)}=w800-h480-c`)
    expect(fetchImage.calls[0][1]).toEqual({ saveAsset: { name: 'google-photos 0 800x480', extension: 'jpg', mode: 'auto' } })
    expect(app.state.photo).toBe(1)
    expect(app.state.meta).toEqual({ source: 'googlePhotos', index: 0, count: 2, imageUrl: `${HOST}${long(1)}=w800-h480-c` })
    // The album is remembered: the next render does not fetch the page again.
    get(app, makeContext())
    expect(http).toHaveBeenCalledTimes(1)
    expect(fetchImage.calls[1][0]).toBe(`${HOST}${long(2)}=w800-h480-c`)
    expect(app.state.photo).toBe(0)
  })

  it('refreshes the album after cacheAlbumSeconds and keeps the old list when the refresh fails', () => {
    const http = mock.httpRequest(() => ({ status: 200, found: page }))
    mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { ...config, cacheAlbumSeconds: 1 } })
    app.memory.set('album', JSON.stringify({ url: config.shareUrl, paths: [long(9)], at: Date.now() / 1000 - 5 }))
    get(app, makeContext())
    expect(http).toHaveBeenCalledTimes(1)
    expect(JSON.parse(app.memory.get('album')!).paths).toEqual([long(1), long(2)])
    app.memory.set('album', JSON.stringify({ url: config.shareUrl, paths: [long(9)], at: 0 }))
    mock.httpRequest(() => ({ status: 500 }))
    const error = mock.error()
    const fetchImage = mock.fetchImage(() => mock.image())
    get(app, makeContext())
    expect(error.calls[0][0]).toContain('reusing the cached photo list')
    expect(fetchImage.calls[0][0]).toContain(long(9))
  })

  it('names a missing link, an empty album, and a failed download', () => {
    expect(() => get(makeApp({ config: { ...config, shareUrl: ' ' } }), makeContext())).toThrow('Please provide a Google Photos shared album link.')
    expect(() => get(makeApp({ config: { ...config, shareUrl: 'photos.app' } }), makeContext())).toThrow('Invalid shared album link')
    mock.httpRequest(() => ({ status: 200, found: ['nothing here'] }))
    expect(() => get(makeApp({ config }), makeContext())).toThrow('No photos found on the shared album page')
    mock.httpRequest(() => ({ status: 404 }))
    expect(() => get(makeApp({ config }), makeContext())).toThrow('Error 404 while fetching the shared album page.')
    mock.httpRequest(() => ({ status: 200, found: page }))
    mock.fetchImage(() => ({ image: null, error: 'no' }))
    expect(() => get(makeApp({ config }), makeContext())).toThrow('Error fetching image from Google Photos: no')
  })
})

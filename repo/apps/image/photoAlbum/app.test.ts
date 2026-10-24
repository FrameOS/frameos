import { albumLink, get, linkOrigin, photoUrl, position, reason, shapesQuery } from './app'

const link = 'https://frames.example/api/photos/shared/pk_test'
const photo = { path: 'beach/a.jpg', name: 'a.jpg', url: '/api/photos/shared/pk_test/file?path=beach%2Fa.jpg', colors: null }

function album(count: number, extra: Record<string, unknown> = {}) {
  return mock.httpRequest((url: string) => {
    if (url.startsWith(`${link}/photo?`)) return mock.json({ index: 0, count, photo: count ? { ...photo, ...extra } : null })
    return mock.response(404, '{"detail":"Not Found"}')
  })
}

describe('photoAlbum helpers', () => {
  it('reads the link, its origin, a photo address and the counter', () => {
    expect(albumLink(` ${link}/ `)).toBe(link)
    expect(albumLink('pk_test')).toBe('')
    expect(albumLink(null)).toBe('')
    expect(linkOrigin(link)).toBe('https://frames.example')
    expect(photoUrl(link, '/file?x=1')).toBe('https://frames.example/file?x=1')
    expect(photoUrl(link, 'https://cdn/x.jpg')).toBe('https://cdn/x.jpg')
    expect(photoUrl(link, 'file.jpg')).toBe('')
    expect(position(3)).toBe(3)
    expect(position('7')).toBe(7)
    expect(position(-1)).toBe(0)
    expect(position('soon')).toBe(0)
  })
  it('cuts addresses and share tokens out of an error text', () => {
    expect(reason(`HTTP request failed: ${link}/photo?index=3`)).toBe('HTTP request failed: https://frames.example')
    expect(reason('Too many HTTP redirects fetching https://u:p@w@cdn.example:8443/x.jpg?sig=1')).toBe(
      'Too many HTTP redirects fetching https://cdn.example:8443'
    )
    expect(reason('HTTP 404: Cannot GET /api/photos/shared/pk_test/file')).toBe('HTTP 404: Cannot GET /api/photos/shared/pk_.../file')
    expect(reason('connect failed: ESP_ERR_HTTP_CONNECT')).toBe('connect failed: ESP_ERR_HTTP_CONNECT')
    expect(reason(null)).toBe('')
  })
  it('asks for the shapes only when one is off', () => {
    expect(shapesQuery({ landscape: true, portrait: 'true', square: true })).toBe('')
    expect(shapesQuery({})).toBe('')
    expect(shapesQuery({ landscape: false, portrait: true, square: 'false' })).toBe('&shapes=portrait')
    expect(shapesQuery({ landscape: false, portrait: false, square: false })).toBe('&shapes=')
  })
})

describe('photoAlbum', () => {
  it('shows the next photo and moves the counter on before the download', () => {
    const http = album(3)
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { album: link, order: 'sequential', counterStateKey: 'photoIndex' }, state: { photoIndex: 1 } })
    expect(get(app, makeContext())).toMatchObject({ __frameosType: 'image' })
    expect(http.calls[0][0]).toBe(`${link}/photo?order=sequential&index=1`)
    expect(http.calls[0][1]).toEqual({ timeoutMs: 20000 })
    expect(fetchImage).toHaveBeenCalledWith('https://frames.example/api/photos/shared/pk_test/file?path=beach%2Fa.jpg', { colors: null })
    expect(app.state.photoIndex).toBe(2)
  })

  it('asks for one photo by path, with its color profile, and leaves the counter alone', () => {
    const http = album(1, { colors: { exposure: 1 } })
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { album: link, photo: 'beach/a.jpg', counterStateKey: 'photoIndex' }, state: { photoIndex: 4 } })
    get(app, makeContext())
    expect(http.calls[0][0]).toBe(`${link}/photo?path=beach%2Fa.jpg`)
    expect(fetchImage.calls[0][1]).toEqual({ colors: { exposure: 1 } })
    expect(app.state.photoIndex).toBe(4)
  })

  it('passes the shape toggles on, and refuses them all off', () => {
    const http = album(2)
    mock.fetchImage(() => mock.image())
    get(makeApp({ config: { album: link, landscape: false, portrait: true, square: true } }), makeContext())
    expect(http.calls[0][0]).toContain('&shapes=portrait,square')
    const error = mock.error()
    const image = get(makeApp({ config: { album: link, landscape: false, portrait: false, square: false } }), makeContext())
    expect(image.svg).toContain('Turn on at least one photo shape')
    expect(error).toHaveBeenCalledTimes(1)
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('paints a calm message for an empty album and keeps the counter', () => {
    album(0)
    const log = mock.log()
    const app = makeApp({ config: { album: link, counterStateKey: 'photoIndex' }, state: { photoIndex: 5 } })
    expect(get(app, makeContext()).svg).toContain('This album has no photos yet.')
    expect(log).toHaveBeenCalledWith('This album has no photos yet.')
    expect(app.state.photoIndex).toBe(5)
  })

  it('paints what went wrong and logs it as an error', () => {
    const error = mock.error()
    expect(get(makeApp({ config: { album: '' } }), makeContext()).svg).toContain('Please add an album link.')
    mock.httpRequest(() => mock.response(404, ''))
    expect(get(makeApp({ config: { album: link } }), makeContext()).svg).toContain('This album link no longer works.')
    mock.httpRequest(() => ({ status: 0, error: 'timeout' }))
    expect(get(makeApp({ config: { album: link } }), makeContext()).svg).toContain('Could not reach the album: timeout')
    mock.httpRequest(() => mock.response(200, 'not json'))
    expect(get(makeApp({ config: { album: link } }), makeContext()).svg).toContain('could not read')
    album(1)
    mock.fetchImage(() => ({ image: null, error: 'gone' }))
    const app = makeApp({ config: { album: link, counterStateKey: 'photoIndex' } })
    expect(get(app, makeContext()).svg).toContain('Could not load a.jpg: gone')
    expect(app.state.photoIndex).toBe(1)
    expect(error).toHaveBeenCalledTimes(5)
  })

  it('never shows the album link or a photo address when a fetch fails', () => {
    const error = mock.error()
    mock.httpRequest((url: string) => ({ status: 0, error: `HTTP request failed: ${url}` }))
    const unreachable = get(makeApp({ config: { album: link } }), makeContext())
    expect(error).toHaveBeenLastCalledWith('Could not reach the album: HTTP request failed: https://frames.example')
    album(1)
    mock.fetchImage((url: string) => ({ image: null, error: `HTTP request refused: deadline passed (${url})` }))
    const failed = get(makeApp({ config: { album: link } }), makeContext())
    expect(error).toHaveBeenLastCalledWith('Could not load a.jpg: HTTP request refused: deadline passed (https://frames.example')
    expect(failed.svg).toContain('https://frames.example')
    for (const text of [unreachable.svg, failed.svg, JSON.stringify(error.calls)]) {
      expect(text).not.toContain('pk_test')
      expect(text).not.toContain('/photo?')
      expect(text).not.toContain('file?path')
    }
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('needs the canvas: it never sizes by the panel', () => {
    expect(() => get(makeApp({ config: { album: link } }), makeContext({ hasImage: false }))).toThrow(
      'No canvas to draw on'
    )
  })
})

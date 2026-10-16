import { get } from './app'

const settings = { unsplash: { accessKey: 'ak' } }
const photo = {
  id: 'abc',
  slug: 'a-forest',
  description: 'A forest',
  alt_description: 'trees',
  created_at: '2026-01-01T00:00:00Z',
  urls: { raw: 'https://images.unsplash.com/photo-1?ixid=1' },
  links: { html: 'https://unsplash.com/photos/abc' },
  location: { name: 'Ardennes' },
  user: { name: 'Ann', username: 'ann', links: { html: 'https://unsplash.com/@ann' } },
}

describe('unsplash', () => {
  it('asks for a random photo of the search and downloads it at the frame size', () => {
    const http = mock.httpRequest(() => mock.json(photo))
    const fetchImage = mock.fetchImage(() => mock.image({ width: 800, height: 480 }))
    const app = makeApp({ settings, config: { search: ' nature ', orientation: 'auto', saveAssets: 'never' } })
    const image = get(app, makeContext())
    expect(image).toMatchObject({ __frameosType: 'image' })
    expect(http.calls[0][0]).toBe('https://api.unsplash.com/photos/random/?orientation=landscape&query=nature')
    expect(http.calls[0][1]).toMatchObject({ headers: { Authorization: 'Client-ID ak', 'Accept-Version': 'v1' } })
    expect(fetchImage).toHaveBeenCalledWith('https://images.unsplash.com/photo-1?ixid=1&w=800&h=480&fit=crop&crop=faces,edges', {
      saveAsset: undefined,
    })
  })

  it('follows the frame orientation, a turned frame and a drawn cell', () => {
    const http = mock.httpRequest(() => mock.json(photo))
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { orientation: 'auto' }, frame: { width: 800, height: 480, rotate: 90 } }), makeContext())
    expect(http.calls[0][0]).toContain('orientation=portrait')
    expect(fetchImage.calls[0][0]).toContain('&w=480&h=800&')
    get(makeApp({ settings, config: { orientation: 'auto' } }), makeContext({ imageWidth: 300, imageHeight: 300 }))
    expect(http.calls[1][0]).toContain('orientation=squarish')
    get(makeApp({ settings, config: { orientation: 'any' } }), makeContext())
    expect(http.calls[2][0]).toContain('orientation=&query=')
  })

  it('keeps the photo metadata in scene state and saves the photo as an asset', () => {
    mock.httpRequest(() => mock.json(photo))
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ settings, config: { search: 'nature', metadataStateKey: 'photo', saveAssets: 'always' } })
    get(app, makeContext())
    expect(app.state.photo).toMatchObject({
      source: 'unsplash',
      search: 'nature',
      id: 'abc',
      title: 'a-forest',
      author: 'Ann',
      authorUrl: 'https://unsplash.com/@ann',
      location: 'Ardennes',
    })
    expect(fetchImage.calls[0][1]).toEqual({ saveAsset: { name: 'nature 800x480', extension: '.jpg', mode: 'always' } })
  })

  it('names what went wrong', () => {
    expect(() => get(makeApp({ settings: {} }), makeContext())).toThrow('Unsplash API key')
    mock.httpRequest(() => mock.response(403, { error: { message: 'Rate limit' } }))
    expect(() => get(makeApp({ settings }), makeContext())).toThrow('Error making request 403: Rate limit')
    mock.httpRequest(() => ({ status: 0, error: 'offline' }))
    expect(() => get(makeApp({ settings }), makeContext())).toThrow('Error fetching image from Unsplash: offline')
    mock.httpRequest(() => mock.json({}))
    expect(() => get(makeApp({ settings }), makeContext())).toThrow('No image URL returned from Unsplash.')
    mock.httpRequest(() => mock.json(photo))
    mock.fetchImage(() => ({ image: null, error: 'decode failed' }))
    expect(() => get(makeApp({ settings }), makeContext())).toThrow('decode failed')
  })
})

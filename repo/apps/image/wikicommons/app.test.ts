import { get } from './app'

const commons = (title: string, extra: Record<string, unknown> = {}) =>
  mock.json({
    query: {
      pages: [
        {
          title,
          imageinfo: [
            {
              mime: 'image/jpeg',
              url: 'https://upload.wikimedia.org/a.jpg',
              thumburl: 'https://upload.wikimedia.org/thumb/a.jpg?x=1',
              descriptionurl: 'https://commons.wikimedia.org/wiki/' + title,
              extmetadata: {
                ImageDescription: { value: '<p>A &quot;view&quot; of the &amp; sea</p>' },
                Artist: { value: '<a href="x">Ann</a>' },
                LicenseShortName: { value: 'CC BY-SA 4.0' },
              },
              ...extra,
            },
          ],
        },
      ],
    },
  })

describe('wikicommons', () => {
  it("fetches today's picture of the day and saves it with its title", () => {
    const http = mock.httpRequest(() => commons('File:Sea view.jpg'))
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { mode: 'pictureOfTheDay', saveAssets: 'auto', metadataStateKey: 'pic' } })
    expect(get(app, makeContext())).toMatchObject({ __frameosType: 'image' })
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(http.calls[0][0]).toContain(`titles=Template%3APotd%2F${day}&gimlimit=20`)
    expect(http.calls[0][0]).toContain('iiurlwidth=800')
    expect(fetchImage.calls[0][0]).toBe('https://upload.wikimedia.org/thumb/a.jpg?x=1')
    expect(fetchImage.calls[0][1]).toEqual({
      headers: { 'User-Agent': 'FrameOS Wikimedia Commons app (https://github.com/FrameOS/frameos)' },
      saveAsset: { name: 'Sea view.jpg', extension: 'jpg', mode: 'auto' },
    })
    expect(app.state.pic).toEqual({
      source: 'wikimedia-commons',
      mode: 'pictureOfTheDay',
      title: 'File:Sea view.jpg',
      description: 'A "view" of the & sea',
      author: 'Ann',
      license: 'CC BY-SA 4.0',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Sea view.jpg',
      imageUrl: 'https://upload.wikimedia.org/thumb/a.jpg?x=1',
      mime: 'image/jpeg',
    })
  })

  it('asks for a random file, retrying when a page has no image', () => {
    let calls = 0
    const http = mock.httpRequest(() =>
      ++calls < 3
        ? mock.json({ query: { pages: [{ title: 'File:x.pdf', imageinfo: [{ mime: 'application/pdf', url: 'u' }] }] } })
        : commons('File:Ok.png', { mime: 'image/png', thumburl: 'https://upload.wikimedia.org/ok.png' })
    )
    mock.fetchImage(() => mock.image())
    get(makeApp({ config: { mode: 'random', saveAssets: 'never' } }), makeContext())
    expect(http).toHaveBeenCalledTimes(3)
    expect(http.calls[0][0]).toContain('generator=random&grnnamespace=6&grnlimit=20')
  })

  it('gives up after ten failed random tries, and names API and download errors', () => {
    mock.httpRequest(() => mock.json({ query: { pages: [] } }))
    expect(() => get(makeApp({ config: { mode: 'random' } }), makeContext())).toThrow('Could not find a random Wikimedia Commons image')
    mock.httpRequest(() => mock.json({ error: { info: 'badtitle' } }))
    expect(() => get(makeApp({ config: { mode: 'pictureOfTheDay' } }), makeContext())).toThrow('Wikimedia Commons API error: badtitle')
    mock.httpRequest(() => mock.response(503, ''))
    expect(() => get(makeApp({ config: { mode: 'pictureOfTheDay' } }), makeContext())).toThrow('Wikimedia Commons API HTTP 503')
    expect(() => get(makeApp({ config: { mode: 'nonsense' } }), makeContext())).toThrow('Invalid Wikimedia Commons mode: nonsense')
    mock.httpRequest(() => commons('File:a.jpg'))
    mock.fetchImage(() => ({ image: null, error: 'huge' }))
    expect(() => get(makeApp({ config: { mode: 'pictureOfTheDay' } }), makeContext())).toThrow('Error fetching image from Wikimedia Commons: huge')
  })
})

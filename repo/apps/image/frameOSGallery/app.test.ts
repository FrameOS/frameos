import { get, onEvent } from './app'

const base = 'https://gallery.frameos.net/image?category=landscapes'
// The canvas a render hands the app: already turned with the frame.
const canvas = (context?: object) => makeContext({ imageWidth: 800, imageHeight: 480, ...(context || {}) })

describe('frameOSGallery', () => {
  it('asks for one photo of the category scaled to the canvas, as a JPEG, and returns its image', () => {
    const fetchImage = mock.fetchImage(() => mock.image({ width: 800, height: 480 }))
    const image = get(makeApp({ config: { category: 'landscapes' } }), canvas())
    expect(fetchImage).toHaveBeenCalledWith(`${base}&width=800&height=480&fit=cover&format=jpg`)
    expect(image).toMatchObject({ __frameosType: 'image', width: 800, height: 480 })
  })

  it('takes the canvas as it comes and never reads the panel: a turned frame hands it a turned canvas', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { category: 'landscapes' }, frame: { width: 800, height: 480, rotate: 90 } })
    get(app, canvas({ imageWidth: 480, imageHeight: 800 }))
    expect(fetchImage.calls[0][0]).toBe(`${base}&width=480&height=800&fit=cover&format=jpg`)
  })

  it("asks for the size the image will be drawn at, with the consumer's placement", () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { category: 'landscapes' } })
    get(app, canvas({ targetWidth: 390, targetHeight: 230, targetFit: 'contain' }))
    expect(fetchImage.calls[0][0]).toBe(`${base}&width=390&height=230&fit=contain&format=jpg`)
    get(app, canvas({ targetWidth: 390, targetHeight: 230, targetFit: 'center' }))
    expect(fetchImage.calls[1][0]).toBe(`${base}&width=390&height=230&fit=cover&format=jpg`)
    get(
      makeApp({ config: { category: 'landscapes', fit: 'cover' } }),
      canvas({ targetWidth: 390, targetHeight: 230, targetFit: 'contain' })
    )
    expect(fetchImage.calls[2][0]).toBe(`${base}&width=390&height=230&fit=cover&format=jpg`)
  })

  it('asks for the original when the run has no canvas to size by', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'landscapes' } }), makeContext({ hasImage: false }))
    expect(fetchImage.calls[0][0]).toBe(base)
  })

  it('asks for a lossless PNG that fits inside the canvas when told to', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'landscapes', format: 'png', fit: 'contain' } }), canvas())
    expect(fetchImage.calls[0][0]).toBe(`${base}&width=800&height=480&fit=contain&format=png`)
  })

  it('asks for the original file when told to', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'landscapes', format: 'original' } }), canvas())
    expect(fetchImage.calls[0][0]).toBe(base)
  })

  it('uses the typed category when "other" is picked, encoded for the URL', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'other', categoryOther: '  cats & dogs ' } }), canvas())
    expect(fetchImage.calls[0][0]).toBe(
      'https://gallery.frameos.net/image?category=cats%20%26%20dogs&width=800&height=480&fit=cover&format=jpg'
    )
  })

  it('asks for a category name when "other" is empty', () => {
    expect(() => get(makeApp({ config: { category: 'other', categoryOther: '  ' } }), canvas())).toThrow(
      'Category (if other)'
    )
  })

  it('throws with the download error', () => {
    mock.fetchImage(() => ({ image: null, error: 'HTTP 503' }))
    expect(() => get(makeApp({ config: { category: 'landscapes' } }), canvas())).toThrow('HTTP 503')
  })
})

describe('frameOSGallery holding a picture', () => {
  const realNow = Date.now
  afterEach(() => {
    Date.now = realNow
  })
  const cute = (nodeId: number, extra?: object) =>
    makeApp({ nodeId, config: { category: 'cute', hold: 60 }, ...(extra || {}) })
  const event = (app: FrameOSApp, name: string, payload: object) => onEvent(app, makeContext({ event: name, payload }))

  it('draws the same picture again until its time is up, at any size, and keeps it for later renders', () => {
    let made = 0
    const fetchImage = mock.fetchImage(() => mock.image({ image: { id: ++made } }))
    const release = mock.releaseImage(() => true)
    const app = cute(101)
    Date.now = () => 1_000_000
    const first = get(app, canvas())
    expect(fetchImage.calls[0][1]).toEqual({ keep: true })
    // A window moved, resized or uncovered: the same picture.
    Date.now = () => 1_030_000
    expect(get(app, canvas({ imageWidth: 400, imageHeight: 300 }))).toBe(first)
    expect(fetchImage.calls.length).toBe(1)
    // The scene's own interval come round: the next one, the last let go.
    Date.now = () => 1_059_000
    const second = get(app, canvas())
    expect(second).not.toBe(first)
    expect(release.calls[0][0]).toBe(first)
  })

  it('turns to the next one at a tap, a key that turns a page, a button press or a swipe, and at nothing else', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    mock.releaseImage(() => true)
    const app = cute(102)
    get(app, canvas())
    // The desktop's keys, a key that turns nothing, a held key, the frame's long press, motion.
    expect(event(app, 'keyDown', { key: 'Tab', code: 'Tab', alt: true })).toBe(false)
    expect(event(app, 'keyDown', { key: 'ArrowRight', code: 'ArrowRight', meta: true })).toBe(false)
    expect(event(app, 'keyDown', { key: 'a', code: 'KeyA' })).toBe(false)
    expect(event(app, 'keyDown', { key: 'ArrowRight', code: 'ArrowRight', repeat: true })).toBe(false)
    expect(event(app, 'button', { label: 'A', action: 'longPress' })).toBe(false)
    expect(event(app, 'pointerMove', { x: 1, y: 1 })).toBe(false)
    expect(event(app, 'swipe', { direction: 'left', pointerType: 'mouse' })).toBe(false)
    get(app, canvas())
    expect(fetchImage.calls.length).toBe(1)
    const turns: [string, object][] = [
      ['tap', { x: 10, y: 10 }],
      ['keyDown', { key: ' ', code: 'Space' }],
      ['keyDown', { key: 'n', code: 'KeyN' }],
      ['keyDown', { key: 'ArrowDown', code: 'ArrowDown' }],
      ['button', { label: 'A', action: 'press' }],
      ['swipe', { direction: 'left', pointerType: 'touch' }],
      ['forward', {}],
    ]
    for (const [name, payload] of turns) {
      expect(event(app, name, payload)).toBe(true)
      get(app, canvas())
    }
    expect(fetchImage.calls.length).toBe(1 + turns.length)
  })

  it('holds one picture a node, and a tap turns every gallery in the scene', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    mock.releaseImage(() => true)
    const left = cute(103)
    const right = makeApp({ nodeId: 104, config: { category: 'masterpieces', hold: 60 } })
    get(left, canvas())
    get(right, canvas())
    get(left, canvas())
    get(right, canvas())
    expect(fetchImage.calls.map((call: any[]) => call[0].split('&')[0])).toEqual([
      'https://gallery.frameos.net/image?category=cute',
      'https://gallery.frameos.net/image?category=masterpieces',
    ])
    event(left, 'tap', { x: 1, y: 1 })
    get(left, canvas())
    get(right, canvas())
    expect(fetchImage.calls.length).toBe(4)
  })

  it("asks for a held picture as big as the desktop it may be drawn on, its window's shape kept", () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    mock.releaseImage(() => true)
    const window = { targetWidth: 400, targetHeight: 300 }
    get(cute(105, { frame: { width: 1280, height: 800, scenes: [] } }), canvas(window))
    expect(fetchImage.calls[0][0]).toBe(
      'https://gallery.frameos.net/image?category=cute&width=1280&height=960&fit=cover&format=jpg'
    )
    get(cute(106, { frame: { width: 1280, height: 800, scenes: [], embedded: true } }), canvas(window))
    expect(fetchImage.calls[1][0]).toContain('&width=400&height=300&')
    // Not held, or not on a desktop: the size it is drawn at, as before.
    get(
      makeApp({ nodeId: 107, config: { category: 'cute' }, frame: { width: 1280, height: 800, scenes: [] } }),
      canvas(window)
    )
    expect(fetchImage.calls[2][0]).toContain('&width=400&height=300&')
    get(cute(108, { frame: { width: 1280, height: 800 } }), canvas(window))
    expect(fetchImage.calls[3][0]).toContain('&width=400&height=300&')
  })

  it('holds nothing on an ESP32: every render decodes its own picture where it is drawn, and a tap still turns it', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = cute(110, { frame: { embedded: true } })
    get(app, canvas())
    get(app, canvas())
    expect(fetchImage.calls.length).toBe(2)
    expect(fetchImage.calls[0].length).toBe(1)
    expect(event(app, 'tap', { x: 1, y: 1 })).toBe(true)
  })

  it('keeps the picture up when the next one does not come, and asks again at the next render', () => {
    let failing = false
    const fetchImage = mock.fetchImage(() => (failing ? { image: null, error: 'HTTP 503' } : mock.image()))
    mock.releaseImage(() => true)
    const app = cute(109)
    const first = get(app, canvas())
    failing = true
    event(app, 'tap', { x: 1, y: 1 })
    expect(get(app, canvas())).toBe(first)
    expect(get(app, canvas())).toBe(first)
    expect(fetchImage.calls.length).toBe(3)
  })
})

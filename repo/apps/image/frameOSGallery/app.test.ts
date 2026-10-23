import { get } from './app'

const base = 'https://gallery.frameos.net/image?category=landscapes'

describe('frameOSGallery', () => {
  it('asks for one photo of the category scaled to the panel, as a JPEG, and returns its image', () => {
    const fetchImage = mock.fetchImage(() => mock.image({ width: 800, height: 480 }))
    const image = get(makeApp({ config: { category: 'landscapes' } }))
    expect(fetchImage).toHaveBeenCalledWith(`${base}&width=800&height=480&fit=cover&format=jpg`)
    expect(image).toMatchObject({ __frameosType: 'image', width: 800, height: 480 })
  })

  it('swaps the sides of a turned frame', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'landscapes' }, frame: { width: 800, height: 480, rotate: 90 } }))
    expect(fetchImage.calls[0][0]).toBe(`${base}&width=480&height=800&fit=cover&format=jpg`)
    get(makeApp({ config: { category: 'landscapes' }, frame: { width: 800, height: 480, rotate: 180 } }))
    expect(fetchImage.calls[1][0]).toBe(`${base}&width=800&height=480&fit=cover&format=jpg`)
  })

  it('asks for the size the image will be drawn at, with the consumer\'s placement', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ config: { category: 'landscapes' } })
    get(app, makeContext({ targetWidth: 390, targetHeight: 230, targetFit: 'contain' }))
    expect(fetchImage.calls[0][0]).toBe(`${base}&width=390&height=230&fit=contain&format=jpg`)
    get(app, makeContext({ targetWidth: 390, targetHeight: 230, targetFit: 'center' }))
    expect(fetchImage.calls[1][0]).toBe(`${base}&width=390&height=230&fit=cover&format=jpg`)
    get(makeApp({ config: { category: 'landscapes', fit: 'cover' } }), makeContext({ targetWidth: 390, targetHeight: 230, targetFit: 'contain' }))
    expect(fetchImage.calls[2][0]).toBe(`${base}&width=390&height=230&fit=cover&format=jpg`)
    get(app, makeContext({ imageWidth: 300, imageHeight: 300 }))
    expect(fetchImage.calls[3][0]).toBe(`${base}&width=800&height=480&fit=cover&format=jpg`)
  })

  it('asks for a lossless PNG that fits inside the panel when told to', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'landscapes', format: 'png', fit: 'contain' } }))
    expect(fetchImage.calls[0][0]).toBe(`${base}&width=800&height=480&fit=contain&format=png`)
  })

  it('asks for the original file when told to', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'landscapes', format: 'original' } }))
    expect(fetchImage.calls[0][0]).toBe(base)
  })

  it('uses the typed category when "other" is picked, encoded for the URL', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'other', categoryOther: '  cats & dogs ' } }))
    expect(fetchImage.calls[0][0]).toBe(
      'https://gallery.frameos.net/image?category=cats%20%26%20dogs&width=800&height=480&fit=cover&format=jpg'
    )
  })

  it('asks for a category name when "other" is empty', () => {
    expect(() => get(makeApp({ config: { category: 'other', categoryOther: '  ' } }))).toThrow('Category (if other)')
  })

  it('throws with the download error', () => {
    mock.fetchImage(() => ({ image: null, error: 'HTTP 503' }))
    expect(() => get(makeApp({ config: { category: 'landscapes' } }))).toThrow('HTTP 503')
  })
})

import { get } from './app'

describe('frameOSGallery', () => {
  it('fetches one photo of the category and returns its image', () => {
    const fetchImage = mock.fetchImage(() => mock.image({ width: 800, height: 480 }))
    const image = get(makeApp({ config: { category: 'landscapes' } }))
    expect(fetchImage).toHaveBeenCalledWith('https://gallery.frameos.net/image?category=landscapes')
    expect(image).toMatchObject({ __frameosType: 'image', width: 800, height: 480 })
  })

  it('uses the typed category when "other" is picked, encoded for the URL', () => {
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ config: { category: 'other', categoryOther: '  cats & dogs ' } }))
    expect(fetchImage.calls[0][0]).toBe('https://gallery.frameos.net/image?category=cats%20%26%20dogs')
  })

  it('asks for a category name when "other" is empty', () => {
    expect(() => get(makeApp({ config: { category: 'other', categoryOther: '  ' } }))).toThrow('Category (if other)')
  })

  it('throws with the download error', () => {
    mock.fetchImage(() => ({ image: null, error: 'HTTP 503' }))
    expect(() => get(makeApp({ config: { category: 'landscapes' } }))).toThrow('HTTP 503')
  })
})

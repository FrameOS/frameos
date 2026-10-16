import { get } from './app'

describe('jsImage', () => {
  it('returns an image spec with the configured size, color and opacity', () => {
    const image = get(makeApp({ config: { width: 64, height: 32, color: '#ff0000', opacity: 0.5 } }))
    expect(image).toEqual({ __frameosType: 'image', width: 64, height: 32, color: '#ff0000', opacity: 0.5 })
  })

  it('uses the defaults from config.json', () => {
    const image = get(makeApp())
    expect(image).toMatchObject({ width: 320, height: 180, color: '#dde7f0', opacity: 1 })
  })
})

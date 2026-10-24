import { get } from './app'

const icons = {
  viewBox: 64,
  map: { '0': 'sunny', '3': 'cloudy', '61': 'rain' },
  icons: {
    sunny: '<circle cx="32" cy="32" r="10" id="sunny"/>',
    'sunny-night': '<circle cx="32" cy="32" r="8" id="moon"/>',
    cloudy: '<rect width="40" height="20" id="cloudy"/>',
    rain: '<rect width="40" height="30" id="rain"/>',
  },
}

describe('weatherIcon', () => {
  it('draws the icon of the weather code, centered in the frame', () => {
    const app = makeApp({ config: { icons, weathercode: 0, isDay: true, size: 0 }, frame: { width: 200, height: 100 } })
    const image = get(app, makeContext())
    expect(image).toMatchObject({ __frameosType: 'image', width: 200, height: 100 })
    expect(image.svg).toContain('id="sunny"')
    expect(image.svg).toContain('viewBox="0 0 200 100"')
    expect(image.svg).not.toContain('<rect x="0" y="0"')
  })

  it('takes the night variant, an unknown code as cloudy, and a fixed size', () => {
    const night = get(makeApp({ config: { icons, weathercode: 0, isDay: false, size: 48 } }), makeContext())
    expect(night.svg).toContain('id="moon"')
    expect(night).toMatchObject({ width: 48, height: 48 })
    const unknown = get(makeApp({ config: { icons, weathercode: 99, isDay: true } }), makeContext())
    expect(unknown.svg).toContain('id="cloudy"')
  })

  it('paints a background unless it is transparent', () => {
    const painted = get(makeApp({ config: { icons, weathercode: 3, background: '#ffffff' } }), makeContext())
    expect(painted.svg).toContain('fill="#ffffff"')
    const clear = get(makeApp({ config: { icons, weathercode: 3, background: 'transparent' } }), makeContext())
    expect(clear.svg).not.toContain('<rect x="0" y="0"')
  })

  it('lays every icon out on a sheet', () => {
    const sheet = get(makeApp({ config: { icons, sheet: true, columns: 2 } }), makeContext())
    for (const id of ['sunny', 'moon', 'cloudy', 'rain']) {
      expect(sheet.svg).toContain(`id="${id}"`)
    }
    expect(sheet.svg.match(/<g transform=/g)).toHaveLength(4)
  })

  it('refuses to run without an icon set', () => {
    expect(() => get(makeApp({ config: { icons: null } }), makeContext())).toThrow('missing icon set')
  })

  it('needs the canvas when it has no size of its own: it never sizes by the panel', () => {
    expect(() => get(makeApp({ config: { icons, weathercode: 3 } }), makeContext({ hasImage: false }))).toThrow(
      'No canvas to draw on'
    )
  })
})

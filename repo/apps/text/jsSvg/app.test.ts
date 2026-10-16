import { get } from './app'

describe('jsSvg', () => {
  it('draws the label in the configured colors', () => {
    const svg = get(makeApp({ config: { label: 'Hello', background: '#000000', foreground: '#ffffff' } }))
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 320 120">/)
    expect(svg).toContain('fill="#000000"')
    expect(svg).toContain('>Hello</text>')
    expect(svg).toContain('fill="#ffffff"')
  })

  it('falls back to its defaults when a value is empty', () => {
    const svg = get(makeApp({ config: { label: '', background: '', foreground: '' } }))
    expect(svg).toContain('>QuickJS</text>')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('fill="#111111"')
  })
})

import { get } from './app'

describe('weatherIcons', () => {
  it('maps every WMO code to an icon that exists, with a label', () => {
    const set = get(makeApp())
    expect(set.viewBox).toBe(64)
    expect(set.palette).toBe('vivid')
    expect(Object.keys(set.map)).toHaveLength(28)
    for (const [code, icon] of Object.entries(set.map)) {
      expect(set.icons[icon as string]).toMatch(/^<g>/)
      expect(set.labels[code]).toBeTruthy()
    }
    expect(set.map['0']).toBe('clear')
    expect(set.labels['95']).toBe('Thunderstorm')
    expect(set.icons['clear-night']).toContain('<path')
  })

  it('draws in the ink and paper colors for a low contrast panel', () => {
    const mono = get(makeApp({ config: { palette: 'auto', lowContrast: true, ink: '#222222', paper: '#ffffff', lineWidth: 2 } }))
    expect(mono.palette).toBe('mono')
    expect(mono.icons.clear).toContain('fill="none"')
    expect(mono.icons.clear).toContain('stroke="#222222"')
    expect(mono.icons.clear).toContain('stroke-width="2"')
    expect(mono.icons.rain).not.toContain('#38BDF8')
    const vivid = get(makeApp({ config: { palette: 'vivid', lineWidth: 0 } }))
    expect(vivid.icons.rain).toContain('#38BDF8')
    expect(vivid.icons.clear).toContain('stroke-width="3"')
  })
})

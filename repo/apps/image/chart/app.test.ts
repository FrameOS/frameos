import { get } from './app'

// The app first: makeContext() gives it the canvas of the app made last.
const draw = (config: Record<string, unknown>, context?: FrameOSContext) => {
  const app = makeApp({ config, frame: { width: 400, height: 200 } })
  return get(app, context ?? makeContext())
}

describe('chart', () => {
  it('draws a line for a list of numbers, with grid, axis labels and a title', () => {
    const image = draw({ data: [1, 3, 2], chartType: 'line', title: 'Load', color: '#2a78d6' })
    expect(image).toMatchObject({ __frameosType: 'image', width: 400, height: 200 })
    expect(image.svg).toContain('viewBox="0 0 400 200"')
    expect(image.svg).toContain('>Load</text>')
    expect(image.svg).toContain('stroke="#2a78d6"')
    expect(image.svg).toContain('stroke-opacity="0.25"')
    expect(image.svg).toMatch(/<path d="M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+" stroke="#2a78d6"/)
    expect(image.svg).toContain('>3</text>')
  })

  it('takes labeled points, a JSON string, and several series with their own colors', () => {
    const labeled = draw({ data: [{ label: 'Mon', value: 1 }, { label: 'Tue', y: '2' }], chartType: 'bar' })
    expect(labeled.svg).toContain('>Mon</text>')
    expect(labeled.svg).toContain('>Tue</text>')
    const series = draw({
      data: JSON.stringify({ labels: [1, 2], series: [{ name: 'a', color: '#ff0000', values: [1, 2] }, [3, 4]] }),
      chartType: 'area',
    })
    expect(series.svg).toContain('fill="#ff0000" fill-opacity="0.35"')
    expect(series.svg).toContain('fill="#1baf7a"')
  })

  it('says so when there is nothing to draw or no room', () => {
    expect(draw({ data: [] }).svg).toContain('No chart data')
    expect(draw({ data: 'not json' }).svg).toContain('No chart data')
    expect(draw({ data: [1, 2] }, makeContext({ imageWidth: 20, imageHeight: 20 })).svg).toContain('Not enough space')
  })

  it('paints a background when asked and hides the grid and labels when told', () => {
    const bare = draw({ data: [1, 2], transparentBackground: false, backgroundColor: '#eeeeee', showGrid: false, showLabels: false })
    expect(bare.svg).toContain('<rect width="400" height="200" fill="#eeeeee"/>')
    expect(bare.svg).not.toContain('stroke-opacity="0.25"')
    expect(bare.svg).not.toContain('<text')
  })

  it('keeps a fixed range and draws a lone point as a dot', () => {
    const fixed = draw({ data: [5, 50], minY: '0', maxY: '100' })
    expect(fixed.svg).toContain('>100</text>')
    expect(fixed.svg).toContain('>0</text>')
    const dot = draw({ data: [null, 4, null], chartType: 'line' })
    expect(dot.svg).toContain('<circle')
  })

  it('needs the canvas: it never sizes by the panel', () => {
    expect(() => draw({ data: [1, 2] }, makeContext({ hasImage: false }))).toThrow('No canvas to draw on')
  })
})

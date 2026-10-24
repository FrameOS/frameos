import { get } from './app'

const icons = {
  viewBox: 64,
  map: { '0': 'clear', '3': 'overcast', '61': 'rain' },
  icons: {
    clear: '<circle id="clear"/>',
    'clear-night': '<circle id="clear-night"/>',
    overcast: '<path id="overcast"/>',
    rain: '<path id="rain"/>',
    cloudy: '<path id="cloudy"/>',
  },
}
const hours = Array.from({ length: 24 }, (_, i) => `2026-01-18T${String(i).padStart(2, '0')}:00`)
const weather = {
  provider: 'open-meteo',
  date: '2026-01-18',
  location: { name: 'Brussels', timezone: 'Europe/Brussels' },
  forecast: {
    current_weather: { time: '2026-01-18T14:15', temperature: 5.7, windspeed: 12, winddirection: 132, is_day: 1, weathercode: 0 },
    current_weather_units: { temperature: '°C', windspeed: 'km/h' },
    hourly_units: { temperature_2m: '°C', precipitation: 'mm', windspeed_10m: 'km/h' },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, i) => i),
      apparent_temperature: hours.map((_, i) => i - 1),
      precipitation: hours.map((_, i) => (i % 6 === 0 ? 1.5 : 0)),
      weathercode: hours.map((_, i) => (i > 18 ? 61 : 0)),
      windspeed_10m: hours.map(() => 10),
      winddirection_10m: hours.map(() => 90),
    },
    daily_units: { temperature_2m_max: '°C', precipitation_sum: 'mm' },
    daily: {
      time: ['2026-01-18', '2026-01-19', '2026-01-20'],
      temperature_2m_max: [11.3, 9, 8],
      temperature_2m_min: [5.5, 3, 2],
      precipitation_sum: [0, 2.5, 0],
      weathercode: [3, 61, 0],
      sunrise: ['2026-01-18T08:35', '2026-01-19T08:34', '2026-01-20T08:33'],
      sunset: ['2026-01-18T17:10', '2026-01-19T17:12', '2026-01-20T17:14'],
      windspeed_10m_max: [10.4, 20, 5],
    },
  },
}

// The app first: makeContext() gives it the canvas of the app made last.
const panel = (config: Record<string, unknown>, context?: FrameOSContext) => {
  const app = makeApp({ config: { weather, icons, ...config }, frame: { width: 600, height: 400 } })
  return get(app, context ?? makeContext())
}

describe('weatherPanel', () => {
  it('draws the current weather over a sky gradient, with the location and the icon', () => {
    const image = panel({ mode: 'current' })
    expect(image).toMatchObject({ __frameosType: 'image', width: 600, height: 400 })
    expect(image.svg).toContain('<linearGradient id="bg"')
    expect(image.svg).toContain('fill="url(#bg)"')
    expect(image.svg).toContain('id="clear"')
    // Text is drawn as glyph outlines: the location header is one more group of them.
    const withoutLocation = panel({ mode: 'current', showLocation: false })
    expect(image.svg.split('<g transform=').length).toBeGreaterThan(withoutLocation.svg.split('<g transform=').length)
  })

  it('draws flat ink on paper for a low contrast panel, and takes a fixed size', () => {
    const image = panel({ mode: 'current', lowContrast: true, width: 300, height: 200, showLocation: false })
    expect(image).toMatchObject({ width: 300, height: 200 })
    expect(image.svg).not.toContain('<linearGradient')
    expect(image.svg).toContain('fill="#FFFFFF"')
    expect(image.svg).toContain('#111111')
    expect(image.svg).not.toContain('rgba(255,255,255')
  })

  it('draws the hourly and daily views', () => {
    const hourly = panel({ mode: 'hourly', hours: 6 })
    expect(hourly.svg).toContain('id="clear"')
    const daily = panel({ mode: 'daily', days: 3 })
    expect(daily.svg).toContain('id="overcast"')
    expect(daily.svg).toContain('id="rain"')
    expect(daily.svg).toContain('id="clear"')
    expect(daily.svg.split('<line ').length).toBeGreaterThan(2)
  })

  it('fills the cell it is drawn into', () => {
    const image = panel({ mode: 'current' }, makeContext({ imageWidth: 250, imageHeight: 150 }))
    expect(image).toMatchObject({ width: 250, height: 150 })
  })

  it('throws when the weather is missing or failed', () => {
    expect(() => panel({ weather: null })).toThrow('Weather unavailable: no data')
    expect(() => panel({ weather: { location: 'x', error: 'No matching locations found.' } })).toThrow('No matching locations found.')
    expect(() => panel({ weather: { date: 'x' } })).toThrow('no forecast')
  })

  it('needs the canvas when it has no size of its own: it never sizes by the panel', () => {
    expect(() => panel({ mode: 'current' }, makeContext({ hasImage: false }))).toThrow('No canvas to draw on')
    expect(panel({ mode: 'current', width: 300, height: 200 }, makeContext({ hasImage: false })).svg).toContain('viewBox="0 0 300 200"')
  })
})

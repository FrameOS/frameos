import { forecastUrl, get } from './app'

const brussels = {
  results: [
    {
      id: 2800866,
      name: 'Brussels',
      latitude: 50.85045,
      longitude: 4.34878,
      timezone: 'Europe/Brussels',
      country: 'Belgium',
      country_code: 'BE',
      admin1: 'Brussels Capital',
      admin2: 'Bruxelles-Capitale',
    },
  ],
}
const forecast = { current_weather: { time: '2026-01-18T22:15', temperature: 5.7 }, daily: { time: ['2026-01-18'] } }
const config = {
  location: 'Brussels',
  date: '2026-01-18',
  forecastDays: 1,
  temperatureUnit: 'celsius',
  windSpeedUnit: 'kmh',
  precipitationUnit: 'mm',
}

function openMeteo() {
  return mock.httpRequest((url: string) => {
    if (url.startsWith('https://geocoding-api.open-meteo.com/v1/search?')) return mock.json(brussels)
    if (url.startsWith('https://api.open-meteo.com/v1/forecast?')) return mock.json(forecast)
    return mock.response(404, '')
  })
}

describe('weather', () => {
  it('geocodes the location, then fetches the forecast in the frame time zone', () => {
    const http = openMeteo()
    const out = get(makeApp({ config, frame: { timeZone: 'Europe/Brussels' } }))
    expect(out).toEqual({
      provider: 'open-meteo',
      forecastModes: ['current', 'hourly', 'daily'],
      date: '2026-01-18',
      location: {
        name: 'Brussels',
        latitude: 50.85045,
        longitude: 4.34878,
        timezone: 'Europe/Brussels',
        country: 'Belgium',
        countryCode: 'BE',
        admin1: 'Brussels Capital',
        admin2: 'Bruxelles-Capitale',
      },
      forecast,
    })
    expect(http.calls[0][0]).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Brussels&count=1&language=en&format=json')
    expect(http.calls[1][0]).toContain('timezone=Europe%2FBrussels')
    expect(http.calls[1][0]).toContain('start_date=2026-01-18&end_date=2026-01-18')
  })

  it('builds the forecast URL from the scene values, whole numbers written with a decimal', () => {
    const url = forecastUrl({ ...config, date: '' , forecastDays: 40 }, 51, 4.5, 'auto', '2026-01-18')
    expect(url).toContain('latitude=51.0&longitude=4.5')
    expect(url).toContain('forecast_days=16')
    expect(url).toContain('temperature_unit=celsius&windspeed_unit=kmh&precipitation_unit=mm')
    expect(forecastUrl({ ...config, date: '2026-02-01' }, 51, 4, 'Europe/Brussels', '2026-02-01')).toContain(
      'start_date=2026-02-01&end_date=2026-02-01'
    )
  })

  it('encodes the location like a form (a space is +, sub-delimiters too)', () => {
    const http = openMeteo()
    get(makeApp({ config: { ...config, location: "Saint John's (NL)" } }))
    expect(http.calls[0][0]).toContain("name=Saint+John%27s+%28NL%29")
  })

  it('uses the geocoded time zone when the frame has none', () => {
    const http = openMeteo()
    get(makeApp({ config, frame: { timeZone: '' } }))
    expect(http.calls[1][0]).toContain('timezone=Europe%2FBrussels')
  })

  it('answers {location, error} about the location itself', () => {
    expect(get(makeApp({ config: { ...config, location: '' } }))).toEqual({ location: '', error: 'Location is required.' })
    mock.httpRequest(() => mock.json({ results: [] }))
    expect(get(makeApp({ config }))).toEqual({ location: 'Brussels', error: 'No matching locations found.' })
  })

  it('throws when a fetch fails, so the cache keeps nothing and can serve the last forecast', () => {
    mock.httpRequest(() => mock.response(500, 'down'))
    expect(() => get(makeApp({ config }))).toThrow('Weather for Brussels: HTTP 500: down')
    mock.httpRequest(() => ({ status: 0, error: 'offline' }))
    expect(() => get(makeApp({ config }))).toThrow('Weather for Brussels: offline')
  })
})

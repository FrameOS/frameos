// Open-Meteo: geocode the location, then fetch its current, hourly and daily forecast.
const enc = (value) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+')
const num = (value) => (Number.isInteger(value) ? `${value}.0` : value)

function fetchJson(url) {
  const { status, body, error } = frameos.httpRequest(url)
  if (!status) throw new Error(error)
  if (status >= 400) throw new Error(`HTTP ${status}${body && `: ${body}`}`)
  return JSON.parse(body)
}

export function forecastUrl(c, latitude, longitude, timezone, date) {
  const days = c.date
    ? `start_date=${enc(date)}&end_date=${enc(date)}`
    : `forecast_days=${Math.max(1, Math.min(16, c.forecastDays))}`
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${num(latitude)}&longitude=${num(
      longitude
    )}&current_weather=true` +
    '&hourly=temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m,winddirection_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,sunrise,sunset,windspeed_10m_max' +
    `&timezone=${enc(timezone)}&temperature_unit=${enc(c.temperatureUnit)}&windspeed_unit=${enc(c.windSpeedUnit)}` +
    `&precipitation_unit=${enc(c.precipitationUnit)}&${days}`
  )
}

export function get(app) {
  const c = app.config
  const location = c.location
  if (!location) return { location: '', error: 'Location is required.' }
  const date = c.date || new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
  try {
    const r = fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${enc(location)}&count=1&language=en&format=json`
    )?.results?.[0]
    if (!r) return { location, error: 'No matching locations found.' }
    const need = (key) => {
      if (!(key in r)) throw new Error(`key not found: ${key}`)
      return r[key]
    }
    const latitude = need('latitude')
    const longitude = need('longitude')
    const timezone = app.frame.timeZone || (r.timezone ?? 'auto')
    const forecast = fetchJson(forecastUrl(c, latitude, longitude, timezone, date))
    const { country, country_code: countryCode, admin1, admin2 } = r
    return {
      provider: 'open-meteo',
      forecastModes: ['current', 'hourly', 'daily'],
      date,
      location: { name: need('name'), latitude, longitude, timezone, country, countryCode, admin1, admin2 },
      forecast,
    }
  } catch (e) {
    return { location, error: e.message }
  }
}

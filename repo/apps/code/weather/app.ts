// Weather from Open-Meteo: geocode the location, then fetch the current,
// hourly and daily forecast for it. JSON over frameos.httpRequest.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const HOURLY = 'temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m,winddirection_10m'
const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,sunrise,sunset,windspeed_10m_max'

export type ForecastConfig = {
  date: string
  forecastDays: number
  temperatureUnit: string
  windSpeedUnit: string
  precipitationUnit: string
}

type Json = Record<string, any>

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function integer(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) ? number : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Percent-encodes one query value the way the Nim app did (std/uri
// encodeUrl): everything but A-Z a-z 0-9 - . _ ~ becomes %XX, a space '+'.
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')
}

// A coordinate as Nim printed a float: 52.0, not 52.
export function floatParam(value: number): string {
  if (Object.is(value, -0)) return '-0.0'
  const printed = String(value)
  return Number.isInteger(value) && !/e/i.test(printed) ? `${printed}.0` : printed
}

// Bare YYYY-MM-DD in the frame's local time (the zone the runtime runs in).
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// The unit and date fields are selects in the editor but free strings in a
// scene's JSON, so every value is encoded like the location is.
export function forecastUrl(
  config: ForecastConfig,
  latitude: number,
  longitude: number,
  timezone: string,
  requestedDate: string
): string {
  const params = [
    `latitude=${floatParam(latitude)}`,
    `longitude=${floatParam(longitude)}`,
    'current_weather=true',
    `hourly=${HOURLY}`,
    `daily=${DAILY}`,
    `timezone=${encodeQueryValue(timezone)}`,
    `temperature_unit=${encodeQueryValue(config.temperatureUnit)}`,
    `windspeed_unit=${encodeQueryValue(config.windSpeedUnit)}`,
    `precipitation_unit=${encodeQueryValue(config.precipitationUnit)}`,
  ]
  if (config.date) {
    params.push(`start_date=${encodeQueryValue(requestedDate)}`)
    params.push(`end_date=${encodeQueryValue(requestedDate)}`)
  } else {
    params.push(`forecast_days=${Math.max(1, Math.min(16, config.forecastDays))}`)
  }
  return `${FORECAST_URL}?${params.join('&')}`
}

export function buildError(location: string, message: string): { location: string; error: string } {
  return { location, error: message }
}

function fetchJson(url: string): unknown {
  const response = frameos.httpRequest(url)
  if (response.status === 0) throw new Error(response.error ?? 'request failed')
  const body = response.body ?? ''
  if (response.status >= 400) throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`)
  return JSON.parse(body)
}

function has(node: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(node, key)
}

// A key the reply must carry, failing with the message the Nim app gave.
function required(node: Json, key: string): unknown {
  if (!has(node, key)) throw new Error(`key not found: ${key}`)
  return node[key]
}

function float(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const c = app.config
  const location = String(c.location ?? '')
  const config: ForecastConfig = {
    date: String(c.date ?? ''),
    forecastDays: integer(c.forecastDays, 1),
    temperatureUnit: String(c.temperatureUnit ?? 'celsius'),
    windSpeedUnit: String(c.windSpeedUnit ?? 'kmh'),
    precipitationUnit: String(c.precipitationUnit ?? 'mm'),
  }
  if (!location) return buildError('', 'Location is required.')

  const requestedDate = config.date || todayIso()
  try {
    const geocode = fetchJson(
      `${GEOCODE_URL}?name=${encodeQueryValue(location)}&count=1&language=en&format=json`
    ) as Json | null
    const results = geocode && typeof geocode === 'object' ? geocode.results : undefined
    if (!Array.isArray(results) || results.length === 0) return buildError(location, 'No matching locations found.')

    const result: Json = results[0] && typeof results[0] === 'object' ? results[0] : {}
    const latitude = float(required(result, 'latitude'))
    const longitude = float(required(result, 'longitude'))
    const geocodedTimezone = has(result, 'timezone') ? text(result.timezone) : 'auto'
    const timezone = text(app.frame.timeZone) || geocodedTimezone

    const forecast = fetchJson(forecastUrl(config, latitude, longitude, timezone, requestedDate))

    const place: Json = { name: text(required(result, 'name')), latitude, longitude, timezone }
    if (has(result, 'country')) place.country = text(result.country)
    if (has(result, 'country_code')) place.countryCode = text(result.country_code)
    if (has(result, 'admin1')) place.admin1 = text(result.admin1)
    if (has(result, 'admin2')) place.admin2 = text(result.admin2)

    return {
      provider: 'open-meteo',
      forecastModes: ['current', 'hourly', 'daily'],
      date: requestedDate,
      location: place,
      forecast,
    }
  } catch (error) {
    return buildError(location, errorMessage(error))
  }
}

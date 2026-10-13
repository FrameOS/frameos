// Waste collection days for a Belgian address, from the recyclecms public API
// behind RecycleApp.be. That API needs no token exchange: one `x-consumer`
// header authorises every call. JSON over frameos.httpRequest.
//
// A failed lookup THROWS, as the Nim app raised, so the failure stays the
// node's error instead of looking like an empty calendar.

const API_ENDPOINT = 'https://api.fostplus.be/recyclecms/public/v1'
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'x-consumer': 'recycleapp.be' }
const DAY_MS = 24 * 60 * 60 * 1000

export type AddressIds = { zip: string; street: string; housenumber: number }
export type CollectionEvent = { summary: string; startTime: string; endTime: string; timezone: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function integer(value: unknown): number {
  const number = Math.trunc(Number(value ?? 0))
  return Number.isFinite(number) ? number : 0
}

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

// Percent-encodes one query value. Street names carry spaces and accents; the
// runtime's HTTP client refuses a request line with either in it.
export function queryParam(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function zipcodesUrl(postalCode: number): string {
  return `${API_ENDPOINT}/zipcodes?q=${queryParam(String(postalCode))}`
}

export function streetsUrl(streetName: string, zipId: string): string {
  return `${API_ENDPOINT}/streets?q=${queryParam(streetName)}&zipcodes=${queryParam(zipId)}`
}

export function collectionsUrl(
  zipId: string,
  streetId: string,
  houseNumber: number,
  fromDate: string,
  toDate: string
): string {
  return (
    `${API_ENDPOINT}/collections?zipcodeId=${queryParam(zipId)}` +
    `&streetId=${queryParam(streetId)}` +
    `&houseNumber=${queryParam(String(houseNumber))}` +
    `&fromDate=${queryParam(fromDate)}` +
    `&untilDate=${queryParam(toDate)}&size=100`
  )
}

// YYYY-MM-DD of a moment: UTC fields for a frame in UTC (or with no zone),
// local fields otherwise (the zone the runtime runs in).
export function dayIso(date: Date, utc: boolean): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

// A configured YYYY-MM-DD, normalised the way chrono did: 2026-02-30 is
// 2026-03-02, 2026-13-01 is 2027-01-01. Anything else is an error.
export function normalizeDay(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid ${field} "${value}": expected YYYY-MM-DD.`)
  const date = new Date(0)
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return dayIso(date, true)
}

// The default range is today .. a year and a day later, in the frame's zone.
export function exportRange(
  exportFrom: string,
  exportUntil: string,
  timezone: string,
  now: number = Date.now()
): { fromDay: string; untilDay: string } {
  const utc = timezone === 'UTC'
  return {
    fromDay: exportFrom ? normalizeDay(exportFrom, 'exportFrom') : dayIso(new Date(now), utc),
    untilDay: exportUntil ? normalizeDay(exportUntil, 'exportUntil') : dayIso(new Date(now + 366 * DAY_MS), utc),
  }
}

function fetchBody(url: string): string {
  const response = frameos.httpRequest(url, { headers: HEADERS })
  if (response.status === 0) throw new Error(response.error ?? 'request failed')
  if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${response.body ?? ''}`)
  return response.body ?? ''
}

function codeMatches(code: unknown, postalCode: number): boolean {
  return typeof code === 'string' && /^[+-]?\d+$/.test(code) && Number(code) === postalCode
}

export function fetchAddressIds(streetName: string, number: number, postalCode: number): AddressIds {
  const zipJson = JSON.parse(fetchBody(zipcodesUrl(postalCode)))
  let zipId = ''
  for (const item of list(zipJson?.items)) {
    if (codeMatches(item?.code, postalCode)) {
      zipId = text(item?.id)
      break
    }
  }
  if (!zipId) throw new Error('Could not find the right zip code.')

  const streetJson = JSON.parse(fetchBody(streetsUrl(streetName, zipId)))
  let streetId = ''
  for (const item of list(streetJson?.items)) {
    if (streetName === text(item?.name)) {
      streetId = text(item?.id)
      break
    }
  }
  if (!streetId) throw new Error('Could not find the right street name.')
  return { zip: zipId, street: streetId, housenumber: number }
}

export function fetchCollections(addressIds: AddressIds, fromDate: string, toDate: string): Record<string, any> {
  const url = collectionsUrl(addressIds.zip, addressIds.street, addressIds.housenumber, fromDate, toDate)
  const collections = JSON.parse(fetchBody(url))
  if (collections && typeof collections === 'object' && !Array.isArray(collections) && 'items' in collections) {
    return collections
  }
  throw new Error('Something went wrong while fetching collections.')
}

export function collectionsToEvents(collections: unknown, language: string, timezone: string): CollectionEvent[] {
  const items = list((collections as Record<string, any> | null)?.items)
  return items.map((item) => {
    const date = text(item?.timestamp).split('T')[0]
    return {
      summary: `Trash: ${text(item?.fraction?.name?.[language])}`,
      startTime: `${date}T08:00:00`,
      endTime: `${date}T08:15:00`,
      timezone,
    }
  })
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const c = app.config
  const timezone = text(app.frame.timeZone) || 'UTC'
  const language = String(c.language ?? 'en')
  const { fromDay, untilDay } = exportRange(String(c.exportFrom ?? ''), String(c.exportUntil ?? ''), timezone)

  frameos.log('Preparing request headers...')
  frameos.log('Fetching collections...')
  frameos.log('Fetching address IDs...')
  const addressIds = fetchAddressIds(String(c.streetName ?? ''), integer(c.number), integer(c.postalCode))
  const collections = fetchCollections(addressIds, fromDay, untilDay)

  frameos.log({ event: 'reply', eventsInRange: list(collections.items).length })
  frameos.log('Converting collections to events...')
  return collectionsToEvents(collections, language, timezone)
}

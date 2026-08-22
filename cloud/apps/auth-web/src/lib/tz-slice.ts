// Per-zone tzdata slices for ESP32 frames (frameos/src/lib/tz.nim, fos_tz.h).
//
// The chip has no tz database; it loads one zone's transitions (~1.5 KB, the
// same {"timezones","dstChanges"} shape as the full tzdata.json) into chrono.
// The cloud sends the slice next to the zone name in `set_settings`
// (`timezone_data`) so the change applies without the frame having to fetch
// anything. The slices are published by the ../tz generator at
// https://tz.frameos.net/zone/<Zone>.json — the same source the device falls
// back to when it only knows a name — so the cloud needs no tzdata of its
// own; a lookup that fails just omits the key and the device fetches it.

export const TZ_SLICE_BASE_URL = 'https://tz.frameos.net/zone/'
const TZ_SLICE_CACHE_MS = 24 * 60 * 60 * 1000
const TZ_SLICE_FETCH_TIMEOUT_MS = 4000
const TZ_SLICE_MAX_BYTES = 8192
const ZONE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+\-/]{0,127}$/

export interface TzSlice {
  timezones: { id: number; name: string }[]
  dstChanges: { tzId: number; name: string; start: number; offset: number }[]
}

type CacheEntry = { at: number; slice: TzSlice | null }
const cache = new Map<string, CacheEntry>()

export function isTzSlice(value: unknown): value is TzSlice {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    Array.isArray(v.timezones) &&
    v.timezones.length > 0 &&
    Array.isArray(v.dstChanges) &&
    v.timezones.every((tz) => tz && typeof tz === 'object' && typeof (tz as { name?: unknown }).name === 'string')
  )
}

export function resetTzSliceCache(): void {
  cache.clear()
}

/**
 * The slice for `zone`, or null when the zone is unknown to tz.frameos.net,
 * malformed, or the lookup failed. Cached per zone for a day either way.
 */
export async function fetchTzSlice(
  zone: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<TzSlice | null> {
  const name = (zone || '').trim()
  if (!name || !ZONE_NAME.test(name) || name === 'UTC' || name === 'Etc/UTC') return null
  const cached = cache.get(name)
  if (cached && now - cached.at < TZ_SLICE_CACHE_MS) return cached.slice
  let slice: TzSlice | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TZ_SLICE_FETCH_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${TZ_SLICE_BASE_URL}${name}.json`, {
        signal: controller.signal,
      })
      if (response.ok) {
        const text = await response.text()
        if (text.length <= TZ_SLICE_MAX_BYTES) {
          const parsed: unknown = JSON.parse(text)
          if (isTzSlice(parsed)) slice = parsed
        }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    slice = null
  }
  // A miss is cached too (shorter), so a typo'd zone does not hit the CDN
  // on every settings push.
  cache.set(name, { at: slice ? now : now - TZ_SLICE_CACHE_MS + 5 * 60 * 1000, slice })
  return slice
}

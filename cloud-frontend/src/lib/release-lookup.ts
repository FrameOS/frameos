// Shared release-listing client for /api/frames/firmware (ESP32 flasher and
// SD image builder). The route proxies api.github.com, so by far the most
// common upstream failure is GitHub itself being down or rate limiting — say
// that instead of a bare "Release lookup failed (502)", while keeping the
// status code visible for bug reports.

export interface ReleaseLookupErrorDetail {
  error?: string
  retry_after?: number
}

// `what` names the request that failed: the listing ("release lookup") or a
// firmware download. Both go through the cloud's own per-client rate limits,
// and a 429 is THAT limiter answering, not GitHub — the message must not
// blame "the release lookup" when it was the third download this hour.
export function releaseLookupErrorMessage(
  status: number,
  detail: ReleaseLookupErrorDetail | string = {},
  what: 'release lookup' | 'firmware download' = 'release lookup'
): string {
  const { error: code, retry_after } = typeof detail === 'string' ? { error: detail } : detail
  if (code === 'release_lookup_failed' || status === 502 || status === 503 || status === 504) {
    return (
      'GitHub seems to be having trouble right now — FrameOS releases are hosted there, ' +
      `and the ${what} did not get through (HTTP ${status}` +
      `${code ? `, ${code}` : ''}). It usually recovers on its own; try again in a few minutes.`
    )
  }
  if (status === 429) {
    const wait =
      typeof retry_after === 'number' && Number.isFinite(retry_after) && retry_after > 0
        ? retry_after >= 120
          ? `about ${Math.ceil(retry_after / 60)} minutes`
          : `${Math.ceil(retry_after)} seconds`
        : 'a few minutes'
    return `Too many ${what}s from your network in a short time (HTTP 429). Try again in ${wait}.`
  }
  if (status === 401) {
    return 'Your session expired — sign in again and retry.'
  }
  return `Could not complete the ${what} (HTTP ${status}${code ? `, ${code}` : ''}). Try again in a moment.`
}

// Decode the error body the route sends (jsonError / the rate limiter) into
// the message above, tolerating an empty or non-JSON body.
export async function releaseLookupErrorFromResponse(
  response: Response,
  what: 'release lookup' | 'firmware download' = 'release lookup'
): Promise<Error> {
  const detail = (await response.json().catch(() => ({}))) as ReleaseLookupErrorDetail
  return new Error(releaseLookupErrorMessage(response.status, detail, what))
}

// The listing changes only when a release ships, yet the add-frame panels ask
// for it on every mount (the ESP32 flasher's panel-picker probe, the SD image
// builder, then the flash itself). Memoise per URL so a page's worth of
// remounts costs one request, concurrent callers share the in-flight fetch,
// and failures are never cached (the next call retries).
const listingFreshMs = 5 * 60 * 1000
const listingCache = new Map<string, { at: number; value: unknown; promise?: Promise<unknown> }>()

// Fetch + decode helper so both components fail with the same message.
export async function fetchReleaseListing<T>(url: string, now: number = Date.now()): Promise<T> {
  const cached = listingCache.get(url)
  if (cached?.promise) {
    return cached.promise as Promise<T>
  }
  if (cached && now - cached.at < listingFreshMs) {
    return cached.value as T
  }
  const promise = (async () => {
    const response = await fetch(url)
    if (!response.ok) {
      throw await releaseLookupErrorFromResponse(response)
    }
    return (await response.json()) as T
  })()
  listingCache.set(url, { at: cached?.at ?? 0, value: cached?.value, promise })
  try {
    const value = await promise
    listingCache.set(url, { at: now, value })
    return value
  } catch (error) {
    listingCache.delete(url)
    throw error
  }
}

export function resetReleaseListingCacheForTests(): void {
  listingCache.clear()
}

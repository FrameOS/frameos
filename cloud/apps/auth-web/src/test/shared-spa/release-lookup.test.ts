import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchReleaseListing,
  releaseLookupErrorMessage,
  resetReleaseListingCacheForTests,
} from '../../../../../../cloud-frontend/src/lib/release-lookup'

// The browser side of /api/frames/firmware: shared by the ESP32 flasher and
// the SD image builder (cloud-frontend/src/lib/release-lookup.ts).

const fetchMock = vi.fn<typeof fetch>()
const listingUrl = '/api/frames/firmware'

beforeEach(() => {
  resetReleaseListingCacheForTests()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('releaseLookupErrorMessage', () => {
  it('names the firmware download and the retry window on a 429', () => {
    expect(releaseLookupErrorMessage(429, { error: 'rate_limited', retry_after: 1800 }, 'firmware download')).toBe(
      'Too many firmware downloads from your network in a short time (HTTP 429). Try again in about 30 minutes.'
    )
    expect(releaseLookupErrorMessage(429, { error: 'rate_limited', retry_after: 45 })).toBe(
      'Too many release lookups from your network in a short time (HTTP 429). Try again in 45 seconds.'
    )
    expect(releaseLookupErrorMessage(429)).toContain('a few minutes')
  })

  it('blames GitHub for upstream failures', () => {
    expect(releaseLookupErrorMessage(502, 'release_lookup_failed')).toContain('GitHub seems to be having trouble')
  })
})

describe('fetchReleaseListing', () => {
  it('serves repeat lookups from memory and shares the in-flight request', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ release: 'v1' })))
    const [a, b] = await Promise.all([fetchReleaseListing(listingUrl), fetchReleaseListing(listingUrl)])
    expect(a).toEqual({ release: 'v1' })
    expect(b).toEqual({ release: 'v1' })
    expect(await fetchReleaseListing(listingUrl)).toEqual({ release: 'v1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches once the listing goes stale and never caches failures', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ error: 'rate_limited', retry_after: 30 }, { status: 429 }))
    )
    await expect(fetchReleaseListing(listingUrl, 1000)).rejects.toThrow('30 seconds')
    fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json({ release: 'v1' })))
    expect(await fetchReleaseListing(listingUrl, 1000)).toEqual({ release: 'v1' })
    fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json({ release: 'v2' })))
    expect(await fetchReleaseListing(listingUrl, 1000 + 5 * 60 * 1000)).toEqual({
      release: 'v2',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

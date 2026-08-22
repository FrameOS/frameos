import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchTzSlice, isTzSlice, resetTzSliceCache } from './tz-slice'

const brussels = {
  timezones: [{ id: 1, name: 'Europe/Brussels' }],
  dstChanges: [
    { tzId: 1, name: 'CET', start: 1729990800, offset: 3600 },
    { tzId: 1, name: 'CEST', start: 1743296400, offset: 7200 },
  ],
}

function fetchReturning(status: number, body: string) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status }))
}

describe('fetchTzSlice', () => {
  afterEach(() => resetTzSliceCache())

  it("fetches the zone's slice from tz.frameos.net and caches it", async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify(brussels))
    expect(await fetchTzSlice('Europe/Brussels', fetchImpl, 1000)).toEqual(brussels)
    expect(await fetchTzSlice('Europe/Brussels', fetchImpl, 2000)).toEqual(brussels)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://tz.frameos.net/zone/Europe/Brussels.json')
  })

  it('omits the slice for unknown zones, bad bodies and failures', async () => {
    expect(await fetchTzSlice('Mars/Olympus', fetchReturning(404, 'not found'))).toBeNull()
    expect(await fetchTzSlice('Europe/Paris', fetchReturning(200, '<html>'))).toBeNull()
    expect(await fetchTzSlice('Europe/Oslo', fetchReturning(200, '{"timezones":[]}'))).toBeNull()
    expect(
      await fetchTzSlice(
        'Europe/Rome',
        vi.fn(async () => {
          throw new Error('offline')
        })
      )
    ).toBeNull()
  })

  it('never asks for UTC, empty or unsafe names', async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify(brussels))
    expect(await fetchTzSlice('', fetchImpl)).toBeNull()
    expect(await fetchTzSlice('UTC', fetchImpl)).toBeNull()
    expect(await fetchTzSlice('../etc/passwd', fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('isTzSlice checks the chrono shape', () => {
    expect(isTzSlice(brussels)).toBe(true)
    expect(isTzSlice({ timezones: [], dstChanges: [] })).toBe(false)
    expect(isTzSlice('x')).toBe(false)
  })
})

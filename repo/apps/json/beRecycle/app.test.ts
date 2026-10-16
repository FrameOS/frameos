import { get } from './app'

const config = {
  postalCode: 2000,
  streetName: 'Meir',
  number: 1,
  language: 'nl',
  exportFrom: '2026-10-01',
  exportUntil: '2026-10-31',
}

function recycleServer(collections: unknown[]) {
  return mock.httpRequest((url: string) => {
    if (url.includes('/zipcodes?')) return mock.json({ items: [{ code: '2000', id: 'zip-2000' }, { code: '2018', id: 'zip-2018' }] })
    if (url.includes('/streets?')) return mock.json({ items: [{ name: 'Meir', id: 'street-1' }] })
    if (url.includes('/collections?')) return mock.json({ items: collections })
    return mock.response(404, 'unknown')
  })
}

describe('beRecycle', () => {
  it('resolves the address, then turns the collections into calendar events', () => {
    const http = recycleServer([
      { timestamp: '2026-10-03T00:00:00.000Z', fraction: { name: { nl: 'Restafval', en: 'Residual' } } },
      { timestamp: '2026-10-10T00:00:00.000Z', fraction: { name: { nl: 'PMD' } } },
    ])
    const events = get(makeApp({ config, frame: { timeZone: 'Europe/Brussels' } }))
    expect(events).toEqual([
      { summary: 'Trash: Restafval', startTime: '2026-10-03T08:00:00', endTime: '2026-10-03T08:15:00', timezone: 'Europe/Brussels' },
      { summary: 'Trash: PMD', startTime: '2026-10-10T08:00:00', endTime: '2026-10-10T08:15:00', timezone: 'Europe/Brussels' },
    ])
    expect(http.calls.map((call) => call[0])).toEqual([
      'https://api.fostplus.be/recyclecms/public/v1/zipcodes?q=2000',
      'https://api.fostplus.be/recyclecms/public/v1/streets?q=Meir&zipcodes=zip-2000',
      'https://api.fostplus.be/recyclecms/public/v1/collections?zipcodeId=zip-2000&streetId=street-1&houseNumber=1&fromDate=2026-10-01&untilDate=2026-10-31&size=100',
    ])
    expect(http.calls[0][1]).toEqual({ headers: { 'User-Agent': 'Mozilla/5.0', 'x-consumer': 'recycleapp.be' } })
  })

  it('names what it could not find', () => {
    recycleServer([])
    expect(() => get(makeApp({ config: { ...config, postalCode: 9999 } }))).toThrow('Could not find the right zip code.')
    expect(() => get(makeApp({ config: { ...config, streetName: 'Nope' } }))).toThrow('Could not find the right street name.')
    expect(() => get(makeApp({ config: { ...config, exportFrom: '1/10/2026' } }))).toThrow('Invalid exportFrom')
  })

  it('throws on an HTTP or transport failure', () => {
    mock.httpRequest(() => mock.response(500, 'down'))
    expect(() => get(makeApp({ config }))).toThrow('HTTP 500: down')
    mock.httpRequest(() => ({ status: 0, error: 'offline' }))
    expect(() => get(makeApp({ config }))).toThrow('offline')
  })
})

import { get, lastReply } from './app'

const settings = { homeAssistant: { url: 'http://ha.local:8123/', accessToken: 'tok' } }

beforeEach(() => {
  lastReply.at = 0
  lastReply.body = ''
})

describe('haSensor', () => {
  it('fetches the entity state with the token and returns it', () => {
    const http = mock.httpRequest(() => mock.json({ entity_id: 'sensor.temp', state: '21.5' }))
    const state = get(makeApp({ settings, config: { entityId: ' sensor.temp ' } }))
    expect(state).toEqual({ entity_id: 'sensor.temp', state: '21.5' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(http.calls[0][0]).toBe('http://ha.local:8123/api/states/sensor.temp')
    expect(http.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer tok' }, timeoutMs: 10000 })
  })

  it('answers from the last reply for a second within the same run', () => {
    const http = mock.httpRequest(() => mock.json({ state: 'on' }))
    get(makeApp({ settings, config: { entityId: 'light.desk' } }))
    expect(get(makeApp({ settings, config: { entityId: 'light.desk' } }))).toEqual({ state: 'on' })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('reports missing settings and a bad entity id without a request', () => {
    const http = mock.httpRequest()
    const error = mock.error()
    expect(get(makeApp({ settings: {}, config: { entityId: 'sensor.temp' } }))).toEqual({
      error: 'Please provide a Home Assistant URL in the settings.',
    })
    expect(get(makeApp({ settings: { homeAssistant: { url: 'x' } }, config: { entityId: 'sensor.temp' } }))).toMatchObject({
      error: 'Please provide a Home Assistant access token in the settings.',
    })
    expect(get(makeApp({ settings, config: { entityId: 'Sensor Temp' } })).error).toContain('Invalid Home Assistant entity id')
    expect(http).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(3)
  })

  it('reports HTTP and transport failures', () => {
    mock.httpRequest(() => mock.response(404, 'nope'))
    expect(get(makeApp({ settings, config: { entityId: 'sensor.temp' } }))).toEqual({
      error: 'Error fetching Home Assistant status: HTTP 404: nope',
    })
    mock.httpRequest(() => ({ status: 0, error: 'timeout' }))
    expect(get(makeApp({ settings, config: { entityId: 'sensor.temp' } })).error).toBe(
      'Error fetching Home Assistant status: timeout'
    )
    mock.httpRequest(() => mock.response(200, 'not json'))
    expect(get(makeApp({ settings, config: { entityId: 'sensor.temp' } })).error).toContain('Error fetching Home Assistant status')
  })
})

import { run } from './app'

describe('jsLogic', () => {
  it('logs that it ran, with the event and the state key', () => {
    const app = makeApp({ config: { stateKey: 'result' } })
    const log = mock.log()
    run(app, makeContext({ event: 'button' }))
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.calls[0][0]).toBe('JS logic app ran')
    expect(log.calls[0][1]).toEqual({ event: 'button', stateKey: 'result' })
  })

  it('falls back to the default state key', () => {
    const log = mock.log()
    run(makeApp({ config: { stateKey: '' } }), makeContext())
    expect(log.calls[0][1]).toMatchObject({ stateKey: 'jsLogicResult' })
  })
})

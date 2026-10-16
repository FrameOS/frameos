import { get, init } from './app'

describe('jsText', () => {
  it('joins the prefix and the message', () => {
    expect(get(makeApp({ config: { prefix: 'Hi', message: 'there' } }), makeContext())).toBe('Hi: there')
  })

  it('names the event once the app is initialized', () => {
    const app = makeApp()
    init(app)
    expect(app.initialized).toBe(true)
    expect(get(app, makeContext({ event: 'render' }))).toBe('FrameOS: Hello from QuickJS (render)')
    expect(get(app, makeContext({ event: '' }))).toBe('FrameOS: Hello from QuickJS')
  })
})

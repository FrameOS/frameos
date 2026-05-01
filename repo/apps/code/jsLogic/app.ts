export function run(app: FrameOSApp, context: FrameOSContext): void {
  const stateKey = app.config.stateKey || 'jsLogicResult'

  app.log('JS logic app ran', { event: context.event, stateKey })

  // Set the delay before the next render, in seconds.
  // frameos.setNextSleep(60)

  // Read existing scene state. State nodes with matching keys read these values.
  // const previous = app.state[stateKey]

  // Persist a value into scene state for connected state nodes to read later.
  // frameos.setState(stateKey, {
  //   updatedAt: Date.now(),
  //   event: context.event,
  //   previous,
  // })

  // Fetch from an API, then write the response into state.
  // const data = frameos.fetchJson('https://api.example.com/status')
  // frameos.setState(stateKey, data)

  // Fetch plain text.
  // const body = frameos.fetchText('https://example.com/')
  // app.log('Fetched characters', body.length)
}

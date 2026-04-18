// <frameos:generated-types>
// Generated from config.json. Edit config.json to update these types.
interface Config {
  /** Duration */
  duration?: number
}

type Output = any
interface App extends FrameOSApp<Config> {}
// </frameos:generated-types>

export function run(app: App) {
  frameos.setNextSleep(app.config.duration)
  app.log(`Next sleep set to ${app.config.duration} seconds`)
}

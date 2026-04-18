// <frameos:generated-types>
/**
 * Generated from config.json. Edit config.json to update these types.
 */
export interface Config {
  /** Duration */
  duration?: number
}

export interface Payload {
  [key: string]: any
}

export type App = FrameOSApp<Config>
export type Context = FrameOSContext<Payload>
// </frameos:generated-types>

export function run(app: App) {
  frameos.setNextSleep(app.config.duration)
  app.log(`Next sleep set to ${app.config.duration} seconds`)
}

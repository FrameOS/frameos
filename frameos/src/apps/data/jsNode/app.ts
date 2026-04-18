// <frameos:generated-types>
/**
 * Generated from config.json. Edit config.json to update these types.
 */
export interface Config {
  /** Target Node */
  targetNode: number
}

export interface Payload {
  /** node output. Example: 1 */
  node: number
}

export type App = FrameOSApp<Config>
export type Context = FrameOSContext<Payload>
// </frameos:generated-types>

export function get(app: App) {
  return frameos.node(app.config.targetNode)
}

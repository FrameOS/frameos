// <frameos:generated-types>
// Generated from config.json. Edit config.json to update these types.
interface Config {
  /** Target Node */
  targetNode: number
}

/** node output. Example: 1 */
type Output = number | FrameOSNodeValue
interface App extends FrameOSApp<Config> {}
// </frameos:generated-types>

export function get(app: App): Output {
  return frameos.node(app.config.targetNode)
}

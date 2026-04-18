// <frameos:generated-types>
// Generated from config.json. Edit config.json to update these types.
interface Config {
  /** Prefix */
  prefix?: string
  /** Message */
  message?: string
}

/** text output. Example: FrameOS: Hello from QuickJS */
type Output = string
interface App extends FrameOSApp<Config> {}
// </frameos:generated-types>

interface App {
  initialized?: boolean
}

export function init(app: App) {
  app.initialized = true
}

export function get(app: App, context: FrameOSContext): Output {
  const eventLabel = context.event ? ` (${context.event})` : ''
  return `${app.config.prefix}: ${app.config.message}${app.initialized ? eventLabel : ''}`
}

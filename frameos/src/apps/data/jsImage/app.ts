// <frameos:generated-types>
/**
 * Generated from config.json. Edit config.json to update these types.
 */
export interface Config {
  /** Width */
  width?: number

  /** Height */
  height?: number

  /** Fill Color */
  color?: string

  /** Opacity */
  opacity?: number
}

export interface Payload {
  /** image output */
  image: string
}

export type App = FrameOSApp<Config>
export type Context = FrameOSContext<Payload>
// </frameos:generated-types>

export function get(app: App) {
  return frameos.image({
    width: app.config.width,
    height: app.config.height,
    color: app.config.color,
    opacity: app.config.opacity,
  })
}

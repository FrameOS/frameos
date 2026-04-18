// <frameos:generated-types>
// Generated from config.json. Edit config.json to update these types.
interface Config {
  /** Width */
  width?: number
  /** Height */
  height?: number
  /** Fill Color */
  color?: string
  /** Opacity */
  opacity?: number
}

/** image output */
type Output = string | FrameOSImageValue | FrameOSImageRef
interface App extends FrameOSApp<Config> {}
// </frameos:generated-types>

export function get(app: App): Output {
  return frameos.image({
    width: app.config.width,
    height: app.config.height,
    color: app.config.color,
    opacity: app.config.opacity,
  })
}

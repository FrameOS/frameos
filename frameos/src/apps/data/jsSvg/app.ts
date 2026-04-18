// <frameos:generated-types>
/**
 * Generated from config.json. Edit config.json to update these types.
 */
export interface Config {
  /** Label */
  label?: string

  /** Background */
  background?: string

  /** Foreground */
  foreground?: string
}

export interface Payload {
  /** text output. Example: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">...</svg> */
  svg: string
}

export type App = FrameOSApp<Config>
export type Context = FrameOSContext<Payload>
// </frameos:generated-types>

export function get(app: App) {
  const label = app.config.label || 'QuickJS'
  const bg = app.config.background || '#ffffff'
  const fg = app.config.foreground || '#111111'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">
    <rect width="320" height="120" rx="18" fill="${bg}" />
    <circle cx="60" cy="60" r="28" fill="${fg}" opacity="0.15" />
    <text x="100" y="70" fill="${fg}" font-size="28" font-family="sans-serif">${label}</text>
  </svg>`
}

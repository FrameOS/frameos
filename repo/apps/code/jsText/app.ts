export function init(app: FrameOSApp): void {
  app.initialized = true
}

export function get(app: FrameOSApp, context: FrameOSContext): string {
  const eventLabel = context.event ? ` (${context.event})` : ''
  return `${app.config.prefix}: ${app.config.message}${app.initialized ? eventLabel : ''}`
}

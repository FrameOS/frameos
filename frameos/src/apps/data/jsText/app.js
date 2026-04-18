export function init(app) {
  app.initialized = true
}

export function get(app, context) {
  const eventLabel = context.event ? ` (${context.event})` : ''
  return `${app.config.prefix}: ${app.config.message}${app.initialized ? eventLabel : ''}`
}

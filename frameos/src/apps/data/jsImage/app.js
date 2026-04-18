export function get(app) {
  return frameos.image({
    width: app.config.width,
    height: app.config.height,
    color: app.config.color,
    opacity: app.config.opacity,
  })
}

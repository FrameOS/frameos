export function get(app) {
  return frameos.node(app.config.targetNode)
}

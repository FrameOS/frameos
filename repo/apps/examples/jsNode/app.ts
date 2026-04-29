export function get(app: FrameOSApp): FrameOSNodeRef {
  return frameos.node(app.config.targetNode)
}

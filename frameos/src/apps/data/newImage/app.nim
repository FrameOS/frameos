import pixie
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    color*: Color
    width*: int
    height*: int
    opacity*: float
    renderNext*: NodeId

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let width = if self.appConfig.width != 0:
                self.appConfig.width
              elif context.hasImage:
                context.image.width
              else:
                self.frameConfig.renderWidth()
  let height = if self.appConfig.height != 0:
                 self.appConfig.height
                elif context.hasImage:
                  context.image.height
                else:
                  self.frameConfig.renderHeight()
  # A scene-supplied size is a request, not an allocation: the same ceiling a
  # decoded image gets (a failed Nim allocation is rawQuit(1), the whole frame).
  let (boundedWidth, boundedHeight) = boundedRequestedDimensions(width, height)
  let image = newImage(boundedWidth, boundedHeight)
  if self.appConfig.opacity != 1.0:
    var color = Color(r: self.appConfig.color.r, g: self.appConfig.color.g, b: self.appConfig.color.b,
        a: float32(self.appConfig.opacity))
    image.fill(color)
  elif self.appConfig.opacity != 0.0:
    image.fill(self.appConfig.color)

  if self.appConfig.renderNext != 0.NodeId:
    var nextContext = ExecutionContext(
        scene: context.scene,
        image: image,
        hasImage: true,
        event: context.event,
        payload: context.payload,
        parent: context,
        nextSleep: context.nextSleep
    )
    self.scene.execNode(self.appConfig.renderNext, nextContext)
    if nextContext.nextSleep != context.nextSleep:
      context.nextSleep = nextContext.nextSleep
  return image

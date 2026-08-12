import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/app_images

type
  AppConfig* = object
    inputImage*: Option[Image]
    color*: Color

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc render*(self: App, context: ExecutionContext, image: Image) =
  image.fill(self.appConfig.color)

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  if self.appConfig.inputImage.isSome:
    result = self.appConfig.inputImage.get()
  else:
    # The intoTarget handshake: an opaque fill is a set that equals the
    # composite, so painting the offered target — the live canvas included —
    # is the materialized draw, minus the allocation. The planner only offers
    # when the color statically resolves opaque (requireOpaqueColor).
    let (target, _) = self.takeDecodeTarget(context)
    result = if not target.isNil:
      target
    elif context.hasImage:
      newImage(context.image.width, context.image.height)
    else:
      newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)


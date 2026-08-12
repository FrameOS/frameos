import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/app_images

type
  AppConfig* = object
    image*: Option[Image]
    opacity*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  # `forwardsTarget`: when the planner routed a decode target through this node
  # the image below is one the chain allocated for itself, so the alpha can be
  # applied to it directly. Without that clearance the input may be a node
  # cache's value or the live canvas, and the copy is what keeps this node from
  # scribbling on someone else's pixels.
  let image = if self.appConfig.image.isSome():
                let input = self.appConfig.image.get()
                if self.mayMutateImageInPlace(context): input else: input.copy()
              elif context.hasImage: newImage(context.image.width, context.image.height)
              else: newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  applyOpacity(image, self.appConfig.opacity)
  return image

proc run*(self: App, context: ExecutionContext) =
  applyOpacity(context.image, self.appConfig.opacity)

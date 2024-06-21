import json
import strformat
import pixie
import options
import frameos/utils/image
import frameos/config
import frameos/types

type
  AppConfig* = object
    inputImage*: Option[Image]
    image*: Image
    placement*: string
    offsetX*: int
    offsetY*: int

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:error", "error": message})

proc render*(self: App, context: ExecutionContext, image: Image) =
  try:
    if self.appConfig.image == nil:
      raise newException(Exception, "No image provided.")
    scaleAndDrawImage(image, self.appConfig.image, self.appConfig.placement, self.appConfig.offsetX,
        self.appConfig.offsetY)
  except Exception as e:
    let message = &"Error rendering image: {e.msg}"
    self.error(message)
    let errorImage = renderError(image.width, image.height, message)
    scaleAndDrawImage(image, errorImage, self.appConfig.placement)

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  result = if self.appConfig.inputImage.isSome:
    self.appConfig.inputImage.get()
  elif context.hasImage:
    newImage(context.image.width, context.image.height)
  else:
    newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)


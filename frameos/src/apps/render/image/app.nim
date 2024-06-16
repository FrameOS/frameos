import json
import strformat
import pixie
import options
import frameos/utils/image
import frameos/types

type
  AppConfig* = object
    image*: Image
    scalingMode*: string
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

proc run*(self: App, context: ExecutionContext) =
  try:
    scaleAndDrawImage(context.image, self.appConfig.image, self.appConfig.scalingMode, self.appConfig.offsetX,
        self.appConfig.offsetY)
  except:
    self.error "An error occurred while rendering image."
    let errorImage = renderError(context.image.width, context.image.height, "An error occurred while rendering image.")
    scaleAndDrawImage(context.image, errorImage, self.appConfig.scalingMode)

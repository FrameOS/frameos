import pixie
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    image*: Image
    width*: int
    height*: int
    scalingMode*: string

  App* = ref object
    nodeId*: NodeId
    frameConfig*: FrameConfig
    scene*: FrameScene
    appConfig*: AppConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc get*(self: App, context: ExecutionContext): Image =
  let image = newImage(self.appConfig.width, self.appConfig.height)
  image.scaleAndDrawImage(self.appConfig.image, self.appConfig.scalingMode)
  return image

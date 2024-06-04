import pixie
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    image*: Image
    width*: int
    height*: int
    scalingMode*: string

  AppOutput* = object
    image*: Image

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

proc run*(self: App, context: ExecutionContext): AppOutput =
  let image = newImage(self.appConfig.width, self.appConfig.height)
  # case self.appConfig.scalingMode:
  #   of "center", "contain", "":
  #     image.fill(self.scene.backgroundColor)
  image.scaleAndDrawImage(self.appConfig.image, self.appConfig.scalingMode)
  return AppOutput(image: image)

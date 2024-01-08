import pixie
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    scalingMode*: string
    width*: int
    height*: int

  App* = ref object
    nodeId*: string
    frameConfig*: FrameConfig
    scene*: FrameScene
    appConfig*: AppConfig

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc run*(self: App, context: ExecutionContext) =
  let image = newImage(self.appConfig.width, self.appConfig.height)
  case self.appConfig.scalingMode:
    of "center", "contain", "":
      image.fill(parseHtmlColor(self.frameConfig.color))
  image.scaleAndDrawImage(context.image, self.appConfig.scalingMode)
  context.image = image

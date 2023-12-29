import pixie
from frameos/types import FrameScene, FrameConfig, ExecutionContext, Logger

type
  AppConfig* = object
    color*: Color

  App* = ref object
    nodeId*: string
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc run*(self: App, context: ExecutionContext) =
  context.image.fill(self.appConfig.color)

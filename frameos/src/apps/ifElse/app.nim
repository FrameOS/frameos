from frameos/types import FrameScene, FrameConfig, ExecutionContext, Logger

type
  AppConfig* = object
    condition*: bool
    thenNode*: string
    elseNode*: string

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

proc run*(self: App, context: var ExecutionContext) =
  if self.appConfig.condition:
    if self.appConfig.thenNode != "":
      self.scene.execNode(self.appConfig.thenNode, context)
  else:
    if self.appConfig.elseNode != "":
      self.scene.execNode(self.appConfig.elseNode, context)

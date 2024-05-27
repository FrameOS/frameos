import frameos/types

type
  AppConfig* = object
    condition*: bool
    thenNode*: NodeId
    elseNode*: NodeId

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc run*(self: App, context: var ExecutionContext) =
  if self.appConfig.condition:
    if self.appConfig.thenNode != 0:
      self.scene.execNode(self.appConfig.thenNode, context)
  else:
    if self.appConfig.elseNode != 0:
      self.scene.execNode(self.appConfig.elseNode, context)

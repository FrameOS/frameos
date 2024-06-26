import frameos/types

type
  AppConfig* = object
    condition*: bool
    thenNode*: NodeId
    elseNode*: NodeId

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc run*(self: App, context: var ExecutionContext) =
  if self.appConfig.condition:
    if self.appConfig.thenNode != 0:
      self.scene.execNode(self.appConfig.thenNode, context)
  else:
    if self.appConfig.elseNode != 0:
      self.scene.execNode(self.appConfig.elseNode, context)

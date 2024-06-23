import json, options
import frameos/types

type
  AppConfig* = object
    duration*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "setNextSleep:log", "message": message})

proc run*(self: App, context: ExecutionContext) =
  context.nextSleep = self.appConfig.duration
  self.log("Set sleep duration between renders to " & $context.nextSleep & " seconds")

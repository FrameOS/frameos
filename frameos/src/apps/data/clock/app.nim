import times
import frameos/types

type
  AppConfig* = object
    format*: string
    formatCustom*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc get*(self: App, context: ExecutionContext): string =
  result = now().format(case self.appConfig.format:
    of "custom": self.appConfig.formatCustom
    else: self.appConfig.format)

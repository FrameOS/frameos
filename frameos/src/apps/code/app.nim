import json, strformat
import pixie
import frameos/types

type
  AppConfig* = object
    keyword*: string

  App* = ref object
    nodeId*: string
    scene*: FrameScene
    frameConfig*: FrameConfig
    appConfig*: AppConfig

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
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
  self.log(&"Hello from {context.event} {self.appConfig.keyword}")
  self.scene.state["count"] = %*(self.scene.state{"count"}.getInt(0) + 1)

  if context.event == "render":
    context.image.fillPath(
      """
        M 20 60
        A 40 40 90 0 1 100 60
        A 40 40 90 0 1 180 60
        Q 180 120 100 180
        Q 20 120 20 60
        z
      """,
      parseHtmlColor("#FC427B").rgba
    )


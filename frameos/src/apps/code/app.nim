import json, strformat
import pixie
from frameos/types import FrameScene, FrameConfig, ExecutionContext, Logger
from frameos/logger import log

type
  AppConfig* = object
    keyword*: string

  App* = ref object
    nodeId*: string
    scene*: FrameScene
    appConfig*: AppConfig

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.node_id}:log", "message": message})

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


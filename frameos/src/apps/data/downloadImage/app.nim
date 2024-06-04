import json
import strformat
import pixie
import times
import options
import frameos/utils/image
import frameos/types

type
  AppConfig* = object
    url*: string

  AppOutput* = object
    image*: Image

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "apps/data/fetchImage:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "apps/data/fetchImage:error", "error": message})

proc run*(self: App, context: ExecutionContext): AppOutput =
  try:
    let url = self.appConfig.url
    return AppOutput(image: downloadImage(url))
  except:
    self.error "An error occurred while downloading image."
    return AppOutput(image: renderText("An error occurred while downloading image."))

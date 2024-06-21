import json
import pixie
import options
import frameos/utils/image
import frameos/config
import frameos/types

type
  AppConfig* = object
    url*: string

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
  self.scene.logger.log(%*{"event": "apps/data/downloadImage:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "apps/data/downloadImage:error", "error": message})

proc get*(self: App, context: ExecutionContext): Image =
  try:
    let url = self.appConfig.url
    return downloadImage(url)
  except:
    self.error "An error occurred while downloading the image."
    return renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), "An error occurred while downloading the image.")

import pixie
import json
import std/strformat
import std/strutils
import options
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    keyword*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "unsplash:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "unsplash:error", "error": message})

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )
  if result.appConfig.keyword == "":
    result.appConfig.keyword = "random"
  result.appConfig.keyword = result.appConfig.keyword.strip()

proc run*(self: App, context: ExecutionContext): Image =
  try:
    let url = &"https://source.unsplash.com/random/{context.image.width}x{context.image.height}/?{self.appConfig.keyword}"
    if self.frameConfig.debug:
      self.log(&"Downloading image: {url}")
    let unsplashImage = downloadImage(url)
    if self.frameConfig.debug:
      self.log("Image downloaded")

    return unsplashImage
  except CatchableError as e:
    return renderError(context.image.width, context.image.height, e.msg)


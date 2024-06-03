import pixie
import json
import std/strformat
import std/strutils
import options
import frameos/config
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

  AppOutput* = object
    image*: Image

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

proc run*(self: App, context: ExecutionContext): AppOutput =
  try:
    let url = &"https://source.unsplash.com/random/{self.frameConfig.renderWidth()}x{self.frameConfig.renderHeight()}/?{self.appConfig.keyword}"
    if self.frameConfig.debug:
      self.log(&"Downloading image: {url}")
    let unsplashImage = downloadImage(url)
    if self.frameConfig.debug:
      self.log("Image downloaded")

    return AppOutput(image: unsplashImage)
  except CatchableError as e:
    return AppOutput(image: renderError(self.frameConfig.renderWidth(), self.frameConfig.renderHeight(), e.msg))


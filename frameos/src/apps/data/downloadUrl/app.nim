import json
import pixie
import options
import frameos/types
import lib/httpclient

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
  self.scene.logger.log(%*{"event": "apps/data/downloadUrl:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": "apps/data/downloadUrl:error", "error": message})

proc get*(self: App, context: ExecutionContext): string =
  let url = self.appConfig.url
  let client = newHttpClient(timeout = 30000)
  try:
    return client.getContent(url)
  except CatchableError as e:
    self.error e.msg
    return e.msg
  finally:
    client.close()

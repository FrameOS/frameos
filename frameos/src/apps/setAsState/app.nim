import json, strformat, options, times, strutils
import lib/httpclient
import frameos/types

type
  AppConfig* = object
    valueString*: string
    valueJson*: JsonNode
    stateKey*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:error", "error": message})

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.valueString != "" and self.appConfig.valueJson != nil:
    self.error("Both valueString and valueJson are set. Only one can be set.")
    return
  if self.appConfig.valueJson != nil and self.appConfig.valueJson.kind != JNull and self.appConfig.valueJson.kind != JNull:
    self.scene.state[self.appConfig.stateKey] = self.appConfig.valueJson
  elif self.appConfig.valueString != "":
    self.scene.state[self.appConfig.stateKey] = %*(self.appConfig.valueString)

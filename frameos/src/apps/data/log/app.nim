import json
import frameos/apps
import frameos/types

type
  AppConfig* = object
    inputJson*: JsonNode

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): JsonNode =
  if self.appConfig.inputJson != nil and self.appConfig.inputJson.kind != JNull and self.appConfig.inputJson.kind != JNull:
    self.log(%*({"event": "log", "message": self.appConfig.inputJson}))
  return self.appConfig.inputJson

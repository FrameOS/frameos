import frameos/types
import json

type
  AppConfig* = object
    json*: JsonNode
    ident*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): string =
  result = pretty(self.appConfig.json, self.appConfig.ident)

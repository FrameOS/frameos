import frameos/types
import json

type
  AppConfig* = object
    json*: JsonNode
    ident*: int
    prettify*: bool

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): string =
  if self.appConfig.prettify:
    result = pretty(self.appConfig.json, self.appConfig.ident)
  else:
    result = $self.appConfig.json

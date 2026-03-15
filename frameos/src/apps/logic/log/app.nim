import json
import frameos/apps
import frameos/types

type
  AppConfig* = object
    inputString*: string
    inputJson*: JsonNode

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc hasJsonPayload(payload: JsonNode): bool =
  payload != nil and payload.kind != JNull

proc run*(self: App, context: ExecutionContext) =
  let hasString = self.appConfig.inputString != ""
  let hasJson = hasJsonPayload(self.appConfig.inputJson)

  if hasString and hasJson:
    self.logError("Both inputString and inputJson are set. Only one can be set.")
    return

  if hasJson:
    self.log(%*{"event": "log", "message": self.appConfig.inputJson})
  elif hasString:
    self.log(%*{"event": "log", "message": self.appConfig.inputString})

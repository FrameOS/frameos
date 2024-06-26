import json
import frameos/apps
import frameos/types

type
  AppConfig* = object
    valueString*: string
    valueJson*: JsonNode
    stateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc run*(self: App, context: ExecutionContext) =
  if self.appConfig.valueString != "" and self.appConfig.valueJson != nil:
    self.logError("Both valueString and valueJson are set. Only one can be set.")
    return
  if self.appConfig.valueJson != nil and self.appConfig.valueJson.kind != JNull and self.appConfig.valueJson.kind != JNull:
    self.scene.state[self.appConfig.stateKey] = self.appConfig.valueJson
  elif self.appConfig.valueString != "":
    self.scene.state[self.appConfig.stateKey] = %*(self.appConfig.valueString)

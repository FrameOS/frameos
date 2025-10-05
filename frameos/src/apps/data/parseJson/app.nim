import frameos/types
import std/json

type
  AppConfig* = object
    text*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): JsonNode =
  try:
    result = parseJson(self.appConfig.text)
  except JsonParsingError as err:
    raise newException(ValueError, "Failed to parse JSON: " & err.msg)

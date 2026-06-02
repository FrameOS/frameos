import frameos/apps
import frameos/types
import frameos/utils/http_client

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): string =
  let url = self.appConfig.url
  try:
    return boundedGetContent(url, maxBytes = self.maxHttpResponseBytes())
  except CatchableError as e:
    self.logError e.msg
    return e.msg

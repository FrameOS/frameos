import frameos/apps
import frameos/types
import frameos/utils/http_fetch

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): string =
  let url = self.appConfig.url
  try:
    let response = fetchUrl(url)
    if response.status < 200 or response.status >= 300:
      raise newException(IOError, errorMessage(response))
    return response.body
  except CatchableError as e:
    self.logError e.msg
    return e.msg

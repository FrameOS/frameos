import options
import httpclient
import frameos/apps
import frameos/types

type
  AppConfig* = object
    url*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): string =
  let url = self.appConfig.url
  let client = newHttpClient(timeout = 30000)
  try:
    return client.getContent(url)
  except CatchableError as e:
    self.logError e.msg
    return e.msg
  finally:
    client.close()

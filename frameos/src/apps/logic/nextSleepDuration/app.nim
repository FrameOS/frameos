import frameos/apps
import frameos/types

type
  AppConfig* = object
    duration*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc run*(self: App, context: ExecutionContext) =
  context.nextSleep = self.appConfig.duration
  self.log("Set sleep duration between renders to " & $context.nextSleep & " seconds")

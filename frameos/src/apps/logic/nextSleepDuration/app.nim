import frameos/apps
import frameos/types
import frameos/refresh_interval

type
  AppConfig* = object
    duration*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc run*(self: App, context: ExecutionContext) =
  ## Sets the scene's refresh interval the way a control panel would: through
  ## the scene's refresh interval state field (refresh_interval.nim), so the
  ## number shows up wherever the scene's options do.
  let duration = self.appConfig.duration
  if not self.scene.setRefreshInterval(duration):
    self.log("Ignored a sleep duration of " & $duration & " seconds; it must be a positive number")
    return
  if context.scene != self.scene:
    # Embedded in another scene (a split-screen panel): the host scene owns
    # the render cycle, so keep telling it through the context as before.
    context.nextSleep = duration
  self.log("Set sleep duration between renders to " & $duration & " seconds")

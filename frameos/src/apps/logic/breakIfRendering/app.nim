import frameos/types

type
  AppConfig* = object
    discard

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc run*(self: App, context: ExecutionContext) =
  if self.scene.isRendering:
    raise newException(Exception, "Abording run because scene is rendering")

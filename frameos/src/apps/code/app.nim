import pixie
from frameos/types import FrameOS, FrameConfig, ExecutionContext

type AppConfig* = object
  keyword*: string
  cacheSeconds*: float

type App* = ref object
  appConfig: AppConfig
  frameConfig: FrameConfig

proc init*(frameOS: FrameOS, appConfig: AppConfig): App =
  result = App(
    frameConfig: frameOS.frameConfig,
    appConfig: appConfig,
  )

proc render*(self: App, context: ExecutionContext) =
  let image = context.image
  image.fillPath(
    """
      M 20 60
      A 40 40 90 0 1 100 60
      A 40 40 90 0 1 180 60
      Q 180 120 100 180
      Q 20 120 20 60
      z
    """,
    parseHtmlColor("#FC427B").rgba
  )


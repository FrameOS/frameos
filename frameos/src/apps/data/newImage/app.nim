import pixie
import frameos/types
import frameos/config

type
  AppConfig* = object
    color*: Color
    width*: int
    height*: int

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    appConfig: appConfig,
    frameConfig: scene.frameConfig,
  )

proc run*(self: App, context: ExecutionContext): Image =
  let width = if self.appConfig.width != 0:
                self.appConfig.width
              elif context.hasImage:
                context.image.width
              else:
                self.frameConfig.renderWidth()
  let height = if self.appConfig.height != 0:
                 self.appConfig.height
                elif context.hasImage:
                  context.image.height
                else:
                  self.frameConfig.renderHeight()
  let image = newImage(width, height)
  image.fill(self.appConfig.color)
  return image

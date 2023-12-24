import pixie
import scenes/default as defaultScene

from frameos/types import FrameConfig, FrameScene, Renderer, Logger

proc newRenderer*(frameConfig: FrameConfig, logger: Logger): Renderer =
  var scene = defaultScene.init(frameConfig)
  result = Renderer(
    frameConfig: frameConfig,
    logger: logger,
    scene: scene,
  )

proc renderScene*(self: Renderer): Image =
  type DefaultScene = defaultScene.Scene
  result = defaultScene.render(self.scene.DefaultScene)

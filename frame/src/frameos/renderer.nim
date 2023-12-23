import pixie
import scenes/default as defaultScene

from frameos/types import Config, FrameScene, Renderer, Logger

proc newRenderer*(config: Config, logger: Logger): Renderer =
  var scene = defaultScene.init(config)
  result = Renderer(
    config: config,
    logger: logger,
    scene: scene,
  )

proc renderScene*(self: Renderer): Image =
  type DefaultScene = defaultScene.Scene
  result = defaultScene.render(self.scene.DefaultScene)

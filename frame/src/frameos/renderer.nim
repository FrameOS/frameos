import pixie
import times
import scenes/default as defaultScene

from frameos/types import FrameConfig, FrameScene, Renderer, Logger

proc newRenderer*(frameConfig: FrameConfig, logger: Logger): Renderer =
  var scene = defaultScene.init(frameConfig).FrameScene
  result = Renderer(
    frameConfig: frameConfig,
    logger: logger,
    scene: scene,
  )

proc renderScene*(self: Renderer): Image =
  let sceneTimer = epochTime()
  echo "Rendering scene: default'"
  type DefaultScene = defaultScene.Scene
  result = defaultScene.render(self.scene.DefaultScene)
  echo "Rendered scene in: ", (epochTime() - sceneTimer) * 1000, " ms"

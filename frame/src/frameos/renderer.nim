import json
import pixie
import times
import scenes/default as defaultScene

from frameos/types import FrameConfig, FrameScene, Renderer, Logger
from frameos/logger import log

proc newRenderer*(frameConfig: FrameConfig, logger: Logger): Renderer =
  var scene = defaultScene.init(frameConfig).FrameScene
  result = Renderer(
    frameConfig: frameConfig,
    logger: logger,
    scene: scene,
  )

proc renderScene*(self: Renderer): Image =
  type DefaultScene = defaultScene.Scene
  let sceneTimer = epochTime()
  result = defaultScene.render(self.scene.DefaultScene)
  self.logger.log(%*{"event": "renderScene", "ms": (epochTime() - sceneTimer) * 1000})

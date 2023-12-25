import json
import pixie
import times
import scenes/default as defaultScene

from frameos/types import FrameOS, FrameConfig, FrameScene, Renderer, Logger
from frameos/logger import log

proc newRenderer*(frameOS: FrameOS): Renderer =
  var scene = defaultScene.init(frameOS).FrameScene
  result = Renderer(
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
    scene: scene,
  )

proc renderScene*(self: Renderer): Image =
  type DefaultScene = defaultScene.Scene
  self.logger.log(%*{"event": "renderScene:start"})
  let sceneTimer = epochTime()
  result = defaultScene.render(self.scene.DefaultScene)
  self.logger.log(%*{"event": "renderScene:done", "ms": (epochTime() -
      sceneTimer) * 1000})

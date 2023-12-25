import json, pixie, times, options
import scenes/default as defaultScene

from frameos/types import FrameOS, FrameConfig, FrameScene, Renderer, Logger
from frameos/logger import log

proc newRenderer*(frameOS: FrameOS): Renderer =
  var scene = defaultScene.init(frameOS).FrameScene
  result = Renderer(
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
    scene: scene,
    lastImage: none(Image),
    lastRenderAt: 0
  )

proc renderScene*(self: Renderer): Image =
  type DefaultScene = defaultScene.Scene
  self.logger.log(%*{"event": "renderScene"})
  let sceneTimer = epochTime()
  result = defaultScene.render(self.scene.DefaultScene)
  self.lastImage = some(result)
  self.lastRenderAt = epochTime()
  self.logger.log(%*{"event": "renderScene:done", "ms": (epochTime() -
      sceneTimer) * 1000})

proc lastRender*(self: Renderer): Image =
  if self.lastImage.isSome and self.lastRenderAt +
      self.frameConfig.interval.toFloat < epochTime():
    result = self.lastImage.get()
  else:
    result = self.renderScene()

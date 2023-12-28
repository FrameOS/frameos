import json, pixie, times, options, asyncdispatch
import scenes/default as defaultScene

from frameos/types import FrameOS, FrameConfig, FrameScene, Renderer, Logger
from frameos/logger import log
from frameos/utils/font import getDefaultTypeface, newFont

import drivers/drivers as drivers

proc newRenderer*(frameOS: FrameOS): Renderer =
  var scene = defaultScene.init(frameOS).FrameScene
  result = Renderer(
    frameOS: frameOS,
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
    scene: scene,
    lastImage: none(Image),
    lastRenderAt: 0,
    sleepFuture: none(Future[void]), )

proc renderError*(frameConfig: FrameConfig, message: string): Image =
  let typeface = getDefaultTypeface()
  let font = newFont(typeface, 32, parseHtmlColor("#ffffff"))
  let padding = 10.0
  result = newImage(frameConfig.width, frameConfig.height)
  result.fill(parseHtmlColor("#000000"))
  result.fillText(
    typeset(
      spans = [newSpan(message, font)],
      bounds = vec2(frameConfig.width.toFloat() - 2 * padding,
          frameConfig.height.toFloat() - 2 * padding),
      hAlign = CenterAlign,
      vAlign = MiddleAlign,
    ),
    translate(vec2(padding, padding))
  )

proc renderScene*(self: Renderer) =
  self.logger.log(%*{"event": "render"})
  let sceneTimer = epochTime()
  try:
    type DefaultScene = defaultScene.Scene
    self.lastImage = some(defaultScene.render(self.scene.DefaultScene))
  except:
    self.logger.log(%*{"event": "render:error"})
  self.lastRenderAt = epochTime()
  self.logger.log(%*{"event": "render:done", "ms": round((epochTime() -
      sceneTimer) * 1000, 3)})

proc lastRender*(self: Renderer): Image =
  if self.lastImage.isSome:
    result = self.lastImage.get()
  else:
    result = renderError(self.frameConfig, "Error: No image rendered yet")

proc startLoop*(self: Renderer): Future[void] {.async.} =
  self.logger.log(%*{"event": "startLoop"})
  var timer = 0.0
  var driverTimer = 0.0
  var sleepDuration = 0.0
  while true:
    timer = epochTime()
    self.renderScene()

    driverTimer = epochTime()
    drivers.render(self.frameOS, self.lastRender())
    self.logger.log(%*{"event": "render:driver",
        "driver": self.frameConfig.device, "ms": round((epochTime() -
            driverTimer) * 1000, 3)})

    # Sleep until the next frame
    sleepDuration = max((self.frameConfig.interval - (epochTime() - timer)) *
        1000, 0.1)
    self.logger.log(%*{"event": "sleep", "ms": round(sleepDuration, 3)})
    # Calculate once more to subtract the time it took to log the message
    sleepDuration = max((self.frameConfig.interval - (epochTime() - timer)) *
        1000, 0.1)
    let future = sleepAsync(sleepDuration)
    self.sleepFuture = some(future)
    await future
    self.sleepFuture = none(Future[void])

proc triggerRender*(self: Renderer): void =
  self.logger.log(%*{"event": "event:render"})
  if self.sleepFuture.isSome:
    self.sleepFuture.get().complete()
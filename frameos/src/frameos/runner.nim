import json, pixie, times, options, asyncdispatch, locks
import scenes/default as defaultScene

from frameos/types import FrameOS, FrameConfig, FrameScene, Logger, RunnerControl
from frameos/utils/image import rotateDegrees, renderError, scaleAndDrawImage

import drivers/drivers as drivers

type
  RunnerThread = ref object
    frameConfig: FrameConfig
    logger: Logger
    scene: FrameScene
    lastImage: Option[Image]
    lastRotatedImage: Option[Image]
    lastRenderAt: float
    sleepFuture: Option[Future[void]]

var
  thread: Thread[(FrameConfig, Logger)]
  toRunner: Channel[JsonNode]
  globalLastImageLock: Lock
  globalLastImage: Option[Image]

toRunner.open()
initLock(globalLastImageLock)

proc renderScene*(self: RunnerThread) =
  self.logger.log(%*{"event": "render"})
  let sceneTimer = epochTime()
  try:
    type DefaultScene = defaultScene.Scene
    let image = defaultScene.render(self.scene.DefaultScene)

    if image.width != self.frameConfig.width or image.height !=
        self.frameConfig.height:
      let resizedImage = newImage(self.frameConfig.width,
          self.frameConfig.height)
      resizedImage.scaleAndDrawImage(image, self.frameConfig.scalingMode)
      withLock(globalLastImageLock):
        globalLastImage = some(resizedImage)
      self.lastImage = some(resizedImage)
      self.lastRotatedImage = some(resizedImage.rotateDegrees(
          self.frameConfig.rotate))
    else:
      withLock(globalLastImageLock):
        globalLastImage = some(image)
      self.lastImage = some(image)
      self.lastRotatedImage = some(image.rotateDegrees(
          self.frameConfig.rotate))
  except Exception as e:
    self.logger.log(%*{"event": "render:error", "error": $e.msg,
        "stacktrace": e.getStackTrace()})
  self.lastRenderAt = epochTime()
  self.logger.log(%*{"event": "render:done", "ms": round((epochTime() -
      sceneTimer) * 1000, 3)})

proc lastRender*(self: RunnerThread): Image =
  if self.lastImage.isSome:
    result = self.lastImage.get()
  else:
    case self.frameConfig.rotate:
      of 90, 270:
        result = renderError(self.frameConfig.height, self.frameConfig.width, "Error: No image rendered yet")
      else:
        result = renderError(self.frameConfig.width, self.frameConfig.height, "Error: No image rendered yet")

proc lastRotatedRender*(self: RunnerThread): Image =
  if self.lastRotatedImage.isSome:
    result = self.lastRotatedImage.get()
  else:
    case self.frameConfig.rotate:
      of 90, 270:
        result = renderError(self.frameConfig.height, self.frameConfig.width, "Error: No image rendered yet")
      else:
        result = renderError(self.frameConfig.width, self.frameConfig.height, "Error: No image rendered yet")
    result = result.rotateDegrees(self.frameConfig.rotate)

proc startRenderLoop*(self: RunnerThread): Future[void] {.async.} =
  self.logger.log(%*{"event": "startRenderLoop"})
  var timer = 0.0
  var driverTimer = 0.0
  var sleepDuration = 0.0
  while true:
    timer = epochTime()
    self.renderScene()

    driverTimer = epochTime()
    drivers.render(self.logger, self.lastRotatedRender())
    self.logger.log(%*{"event": "render:driver",
        "device": self.frameConfig.device, "ms": round((epochTime() -
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

proc triggerRender*(self: RunnerThread): void =
  if self.sleepFuture.isSome:
    self.sleepFuture.get().complete()
  else:
    self.logger.log(%*{"event": "render",
        "error": "Render already in progress, ignoring."})

proc startMessageLoop*(self: RunnerThread): Future[void] {.async.} =
  while true:
    let (success, message) = toRunner.tryRecv()
    if success:
      echo "Got message: " & $message
      case message{"event"}.getStr:
        of "render":
          self.triggerRender()
    else:
      await sleepAsync(50)

proc createThreadRunner*(args: (FrameConfig, Logger)) =
  {.cast(gcsafe).}: # TODO: is this a mistake?
    var scene = defaultScene.init(args[0], args[1]).FrameScene
    var runnerThread = RunnerThread(
      frameConfig: args[0],
      logger: args[1],
      scene: scene,
      lastImage: none(Image),
      lastRotatedImage: none(Image),
      lastRenderAt: 0,
      sleepFuture: none(Future[void]),
    )
    waitFor runnerThread.startRenderLoop() and runnerThread.startMessageLoop()

proc getLastImage*(self: RunnerControl): Image =
  withLock(globalLastImageLock):
    if globalLastImage.isNone:
      case self.frameConfig.rotate:
        of 90, 270:
          result = renderError(self.frameConfig.height, self.frameConfig.width,
            "Error: No image rendered yet")
        else:
          result = renderError(self.frameConfig.width, self.frameConfig.height,
            "Error: No image rendered yet")
    else:
      result = globalLastImage.get()

proc newRunner*(frameConfig: FrameConfig, logger: Logger): RunnerControl =
  var runner = RunnerControl(
    logger: logger,
    frameConfig: frameConfig,
    start: proc () = createThread(thread, createThreadRunner, (
      frameConfig, logger)),
    sendEvent: proc (event: string, payload: JsonNode) =
    toRunner.send(%*{"event": event, "payload": payload}),
  )
  return runner

proc triggerRender*(self: RunnerControl): void =
  self.sendEvent("render", %*{})

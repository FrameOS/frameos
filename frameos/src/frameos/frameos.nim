import json, asyncdispatch, pixie, chroma, strutils

import frameos/types
from frameos/config import loadConfig
from frameos/logger import newLogger
from frameos/metrics import newMetricsLogger
from frameos/server import newServer, startServer
from frameos/runner import newRunner
import drivers/drivers as drivers

proc newFrameOS*(): FrameOS =
  var frameConfig = loadConfig()
  var logger = newLogger(frameConfig)
  logger.log(%*{"event": "startup"})
  var metricsLogger = newMetricsLogger(frameConfig)
  result = FrameOS(
    frameConfig: frameConfig,
    logger: logger,
    metricsLogger: metricsLogger
  )
  drivers.init(result)
  result.runner = newRunner(frameConfig)
  result.server = newServer(result)

proc start*(self: FrameOS) {.async.} =
  var message = %*{"event": "bootup", "config": {
    "frameHost": self.frameConfig.frameHost,
    "framePort": self.frameConfig.framePort,
    "frameAccess": self.frameConfig.frameAccess,
    "width": self.frameConfig.width,
    "height": self.frameConfig.height,
    "device": self.frameConfig.device,
    "metricsInterval": self.frameConfig.metricsInterval,
    "scalingMode": self.frameConfig.scalingMode,
    "rotate": self.frameConfig.rotate,
    "debug": self.frameConfig.debug,
  }}
  self.logger.log(message)
  self.runner.start()
  result = self.server.startServer()

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

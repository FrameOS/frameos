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
  result.runner = newRunner(frameConfig, logger)
  result.server = newServer(result)

proc start*(self: FrameOS) {.async.} =
  var message = %*{"event": "bootup", "config": {
    "framePort": self.frameConfig.framePort,
    "width": self.frameConfig.width,
    "height": self.frameConfig.height,
    "device": self.frameConfig.device,
    "interval": self.frameConfig.interval,
    "metrics_interval": self.frameConfig.metricsInterval,
    "scaling_mode": self.frameConfig.scalingMode,
    "rotate": self.frameConfig.rotate,
    "background_color": self.frameConfig.backgroundColor.toHtmlHex.toLowerAscii,
  }}
  self.logger.log(message)
  self.runner.start()
  self.server.startServer()

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

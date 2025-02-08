import json, asyncdispatch, pixie, strutils
import drivers/drivers as drivers
import frameos/config
import frameos/logger
import frameos/metrics
import frameos/runner
import frameos/server
import frameos/scheduler
import frameos/types
import lib/tz

proc newFrameOS*(): FrameOS =
  initTimeZone()
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
  startScheduler(result)

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
    "assetsPath": self.frameConfig.assetsPath,
    "saveAssets": self.frameConfig.saveAssets,
    "logToFile": self.frameConfig.logToFile,
    "debug": self.frameConfig.debug,
    "timeZone": self.frameConfig.timeZone,
  }}
  self.logger.log(message)
  self.runner.start()
  result = self.server.startServer()

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

import json, asyncdispatch, pixie, strutils, times, os
import httpclient
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
    "gpioButtons": self.frameConfig.gpioButtons,
  }}
  self.logger.log(message)

  # Check if there's an internet connection or until timeout
  if self.frameConfig.network.networkCheck and self.frameConfig.network.networkCheckTimeoutSeconds > 0:
    let url = self.frameConfig.network.networkCheckUrl
    let timeout = self.frameConfig.network.networkCheckTimeoutSeconds
    let timer = epochTime()
    var attempt = 1
    self.logger.log(%*{"event": "networkCheck", "url": url})
    while true:
      if epochTime() - timer >= timeout:
        self.logger.log(%*{"event": "networkCheck", "status": "timeout", "seconds": timeout})
        break
      let client = newHttpClient(timeout = 5000)
      try:
        let response = client.get(url)
        if response.status.startsWith("200"):
          self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "success"})
          break
        else:
          self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "failed",
              "response": response.status})
      except CatchableError as e:
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "error", "error": e.msg})
      finally:
        client.close()
      sleep(attempt * 1000)
      attempt += 1

  self.runner.start()
  result = self.server.startServer()

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

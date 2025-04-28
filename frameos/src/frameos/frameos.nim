import json, asyncdispatch, pixie, strutils, times, os, threadpool
import drivers/drivers as drivers
import frameos/config
import frameos/logger
import frameos/metrics
import frameos/runner
import frameos/server
import frameos/scheduler
import frameos/types
import frameos/portal as netportal
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

proc checkNetwork(frameConfig: FrameConfig) {.gcsafe.} =
  ## Runs in its own thread.  Respect the new captive-portal mode.
  let timeout = min(frameConfig.network.networkCheckTimeoutSeconds, 30.0)
  let mode = frameConfig.network.wifiHotspot
  var firstRun = true

  while true:
    case mode
    of "bootOnly":
      ## Only the very first attempt may start the hotspot.
      if firstRun:
        discard netportal.ensureConnection(frameConfig.network.networkCheckUrl, timeout)
        firstRun = false
      else:
        ## After boot we merely ping the URL; no hotspot logic.
        discard netportal.networkUp(frameConfig.network.networkCheckUrl, int(timeout * 1000))
      sleep(timeout.int * 1000)

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

  netportal.setLogger(self.logger)

  # ----- launch runner right away (it just draws the “booting” frame) -------
  self.runner.start()

  # ----- 1️⃣ kick off the *blocking* network-check on a helper thread -------
  if self.frameConfig.network.networkCheck:
    spawn checkNetwork(self.frameConfig)

  ## give `startAp()` (possibly triggered by checkNetwork) up to 1 s to
  ## become active.  If the hotspot *is* active we wait an extra 10 s so that
  ## clients can associate before the HTTP server comes up.
  var apActive = false
  for _ in 0 .. 9:
    if netportal.active: apActive = true; break
    await sleepAsync(100) # 100 ms
  if apActive:
    await sleepAsync(10_000)

  ## This call never returns, keeping the main future—and the process—alive.
  await self.server.startServer()

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

import json, asyncdispatch, pixie, strutils, options
import drivers/drivers as drivers
import frameos/config
import frameos/logger
import frameos/metrics
import frameos/runner
import frameos/server
import frameos/scheduler
import frameos/types
import frameos/portal as netportal
import frameos/tls_proxy
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
    metricsLogger: metricsLogger,
    network: Network(
      status: NetworkStatus.idle,
      hotspotStatus: HotspotStatus.disabled,
    ),
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
    "deviceConfig": self.frameConfig.deviceConfig,
    "metricsInterval": self.frameConfig.metricsInterval,
    "scalingMode": self.frameConfig.scalingMode,
    "rotate": self.frameConfig.rotate,
    "flip": self.frameConfig.flip,
    "assetsPath": self.frameConfig.assetsPath,
    "saveAssets": self.frameConfig.saveAssets,
    "logToFile": self.frameConfig.logToFile,
    "debug": self.frameConfig.debug,
    "timeZone": self.frameConfig.timeZone,
    "gpioButtons": self.frameConfig.gpioButtons
  }}
  self.logger.log(message)
  netportal.setLogger(self.logger)

  var firstSceneId: Option[SceneId] = none(SceneId)
  if self.frameConfig.network.networkCheck:
    let connected = checkNetwork(self)
    if self.frameConfig.network.wifiHotspot == "bootOnly":
      if connected:
        netportal.stopAp(self)
      else:
        netportal.startAp(self)
        firstSceneId = some("system/wifiHotspot".SceneId)
  else:
    self.logger.log(%*{"event": "networkCheck", "status": "skipped"})

  self.runner.start(firstSceneId)

  startTlsProxy(self.frameConfig, self.logger)

  ## This call never returns
  await self.server.startServer()

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

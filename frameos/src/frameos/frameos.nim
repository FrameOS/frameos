import json, asyncdispatch, pixie, strutils, options
import std/oserrors
import drivers/drivers as drivers
import frameos/config
import frameos/logger
import frameos/metrics
import frameos/runner
import frameos/scenes
import frameos/server
import frameos/scheduler
import frameos/types
import frameos/portal as netportal
import frameos/tls_proxy
import frameos/setup_proxy
import frameos/boot_guard
import lib/tz
when not defined(windows):
  import posix

type
  FatalStartupError* = object
    message*: string
    showStackTrace*: bool

proc addressInUseErrorCode(): OSErrorCode =
  when defined(windows):
    OSErrorCode(10048)
  else:
    OSErrorCode(EADDRINUSE)

proc applyBootGuardStartupFallback*(firstSceneId: var Option[SceneId], bootCrashCount: int): bool =
  if shouldUseFallbackScene(bootCrashCount):
    firstSceneId = some(bootGuardFallbackSceneId().SceneId)
    return true
  false

proc describeFatalStartupError*(err: ref CatchableError): FatalStartupError =
  result = FatalStartupError(
    message: "FrameOS fatal: " & err.msg,
    showStackTrace: true,
  )

  if err of OSError:
    let osErr = (ref OSError)(err)
    if osErr.errorCode.OSErrorCode == addressInUseErrorCode():
      try:
        let config = loadConfig()
        result = FatalStartupError(
          message: "FrameOS fatal: Web server could not start because " &
            serverBindAddress(config) & ":" & $serverPort(config) &
            " is already in use. Stop the existing process or change `framePort` in " &
            getConfigFilename() & ".",
          showStackTrace: false,
        )
      except CatchableError:
        result = FatalStartupError(
          message: "FrameOS fatal: Web server could not start because the configured port is already in use.",
          showStackTrace: false,
        )

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
  loadSceneModules()
  drivers.loadDriverModules()
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

  let bootCrashCount = registerBootCrash()
  self.logger.log(%*{"event": "boot:guard", "crashesWithoutRender": bootCrashCount})
  if applyBootGuardStartupFallback(firstSceneId, bootCrashCount):
    self.logger.log(%*{"event": "boot:guard:fallback", "sceneId": bootGuardFallbackSceneId(),
      "crashesWithoutRender": bootCrashCount, "threshold": BOOT_GUARD_CRASH_LIMIT})

  self.runner.start(firstSceneId)

  startTlsProxy(self.frameConfig, self.logger)

  try:
    ## This call never returns
    self.server.startServer()
  finally:
    stopSetupProxy()
    stopTlsProxy(self.logger)

proc startFrameOS*() {.async.} =
  var frameOS = newFrameOS()
  await frameOS.start()

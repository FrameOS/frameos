import json, asyncdispatch, pixie, strutils, options
import std/oserrors
import drivers/drivers as drivers
import frameos/apps
import frameos/config
import frameos/logger
import frameos/metrics
import frameos/runner
import frameos/reboot_reason
import frameos/server
import frameos/scheduler
import frameos/scenes
import frameos/timezone_updater
import frameos/types
import frameos/utils/memory
import frameos/portal as netportal
import frameos/cloud/hub_client
import frameos/tls_proxy
import frameos/setup_proxy
import frameos/boot_guard
import frameos/utils/image
import frameos/watchdog
import lib/tz
when not defined(windows):
  import posix

type
  FatalStartupError* = object
    message*: string
    showStackTrace*: bool
  FatalStartupRetryAction* = object
    quitProcess*: bool
    showError*: bool
    retrySeconds*: float

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

proc defaultErrorBehavior*(): ErrorBehaviorConfig =
  ErrorBehaviorConfig(
    mode: "show_error_retry",
    retrySeconds: 60,
    silentRetrySeconds: 60,
    silentRetryForever: false,
    silentWindowMinutes: 10,
    showErrorRetrySeconds: 60,
  )

proc loadFatalErrorBehavior*(): ErrorBehaviorConfig =
  try:
    result = loadConfig().errorBehavior
    if result == nil:
      result = defaultErrorBehavior()
  except CatchableError:
    result = defaultErrorBehavior()

proc fatalStartupRetryAction*(behavior: ErrorBehaviorConfig, firstFailureAt, now: float): FatalStartupRetryAction =
  let config = if behavior == nil: defaultErrorBehavior() else: behavior
  case config.mode:
  of "show_error_retry":
    FatalStartupRetryAction(quitProcess: false, showError: true, retrySeconds: config.retrySeconds)
  of "silent_retry":
    if config.silentRetryForever or now - firstFailureAt < config.silentWindowMinutes * 60:
      FatalStartupRetryAction(quitProcess: false, showError: false, retrySeconds: config.silentRetrySeconds)
    else:
      FatalStartupRetryAction(quitProcess: false, showError: true, retrySeconds: config.showErrorRetrySeconds)
  else:
    FatalStartupRetryAction(quitProcess: true, showError: false, retrySeconds: 0)

proc renderFatalStartupError*(fatalError: FatalStartupError) =
  try:
    let frameConfig = loadConfig()
    initTimeZone()
    var logger = newLogger(frameConfig)
    var frameOS = FrameOS(
      frameConfig: frameConfig,
      logger: logger,
      network: Network(
        status: NetworkStatus.idle,
        hotspotStatus: HotspotStatus.disabled,
      ),
    )
    drivers.init(frameOS)
    let image = renderError(frameConfig.renderWidth(), frameConfig.renderHeight(), fatalError.message)
    setLastImage(image)
    drivers.render(image)
  except CatchableError as renderFailure:
    stderr.writeLine("FrameOS fatal: Could not render fatal error: " & renderFailure.msg)

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
  var frameConfig = loadConfig()
  initTimeZone()
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
  # Display drivers are initialized later, in start(): first the network
  # check and boot hotspot get their chance to run, so a display driver that
  # crashes or hangs during init (bad SPI overlay, wrong pins, unvalidated
  # panel) cannot leave the frame both blank AND unreachable. A frame with a
  # broken display but a live hotspot/network can still be debugged.
  result.runner = newRunner(frameConfig)
  result.server = newServer(result)
  startScheduler(result)
  startTimezoneUpdater(result)

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
    "imageEngine": getEffectiveRuntimeImageEngine(),
    "rotate": self.frameConfig.rotate,
    "flip": self.frameConfig.flip,
    "assetsPath": self.frameConfig.assetsPath,
    "saveAssets": self.frameConfig.saveAssets,
    "logToFile": self.frameConfig.logToFile,
    "debug": self.frameConfig.debug,
    "timeZone": self.frameConfig.timeZone,
    "timeZoneUpdates": {
      "enabled": self.frameConfig.timeZoneUpdates.enabled,
      "hour": self.frameConfig.timeZoneUpdates.hour,
      "url": self.frameConfig.timeZoneUpdates.url,
    },
    "gpioButtons": self.frameConfig.gpioButtons,
    "errorBehavior": {
      "mode": self.frameConfig.errorBehavior.mode,
      "retrySeconds": self.frameConfig.errorBehavior.retrySeconds,
      "silentRetrySeconds": self.frameConfig.errorBehavior.silentRetrySeconds,
      "silentRetryForever": self.frameConfig.errorBehavior.silentRetryForever,
      "silentWindowMinutes": self.frameConfig.errorBehavior.silentWindowMinutes,
      "showErrorRetrySeconds": self.frameConfig.errorBehavior.showErrorRetrySeconds
    }
  }}
  let rebootInfo = startupRebootInfoSnapshot()
  if rebootInfo.len > 0:
    message["reboot"] = rebootInfo
  self.logger.log(message)
  netportal.setLogger(self.logger)
  # Decide (and log) NetworkManager vs wpa_supplicant before anything touches
  # the radio, and let the supplicant backend rejoin its saved network.
  netportal.ensureNetworkBackendReady(self)

  var firstSceneId: Option[SceneId] = none(SceneId)
  # The boot hotspot needs a connectivity probe to decide whether to start,
  # so it runs the network check even when "wait for network" is switched off.
  let hotspotBootOnly = self.frameConfig.network.wifiHotspot == "bootOnly"
  if self.frameConfig.network.networkCheck or hotspotBootOnly:
    let connected = checkNetwork(self)
    if hotspotBootOnly:
      if connected:
        netportal.stopAp(self)
      else:
        netportal.startAp(self)
        if self.network.hotspotStatus == HotspotStatus.enabled:
          firstSceneId = some("system/wifiHotspot".SceneId)
        else:
          self.logger.log(%*{"event": "portal:startAp:startupFailed",
                             "status": $self.network.hotspotStatus})
  else:
    self.logger.log(%*{"event": "networkCheck", "status": "skipped"})

  let bootCrashCount = registerBootCrash()
  self.logger.log(%*{"event": "boot:guard", "crashesWithoutRender": bootCrashCount})
  if applyBootGuardStartupFallback(firstSceneId, bootCrashCount):
    self.logger.log(%*{"event": "boot:guard:fallback", "sceneId": bootGuardFallbackSceneId(),
      "crashesWithoutRender": bootCrashCount, "threshold": BOOT_GUARD_CRASH_LIMIT})

  # Deliberately after the network check, boot hotspot and boot-crash
  # accounting: a driver that dies here leaves a reachable frame, and the
  # crash is counted by the boot guard on the next attempt.
  drivers.init(self)

  self.runner.start(firstSceneId)

  # Cloud-managed frames (docs/cloud-frames.md): a background thread completes
  # any pending claim-token enrollment from provisioning and, once the frame is
  # enrolled, dials the provider's management WebSocket. Idles cheaply when the
  # frame is standalone or backend-managed.
  startCloudManagement(self.frameConfig)

  startTlsProxy(self.frameConfig, self.logger)

  try:
    ## This call never returns
    self.server.startServer()
  finally:
    stopSetupProxy()
    stopTlsProxy(self.logger)

proc startFrameOS*() {.async.} =
  # Tell systemd (Type=notify) we are up before any slow driver or scene
  # init; the runner loop takes over with WATCHDOG=1 heartbeats from here.
  notifyReady()
  setupRenderMemory()
  var frameOS = newFrameOS()
  await frameOS.start()

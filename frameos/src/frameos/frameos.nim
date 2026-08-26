import json, asyncdispatch, pixie, strutils, strformat, options, times
import std/oserrors
import std/monotimes
import drivers/drivers as drivers
import frameos/apps
import frameos/config
import frameos/display_detect
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
import frameos/utils/status_screen
import frameos/utils/time
import frameos/render_stats
import frameos/version
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

# --- Boot screen -------------------------------------------------------------
#
# An HDMI frame used to sit on a black panel from power-on until the first
# scene rendered — through the whole network check, which can be 90 s on a
# bad router. The framebuffer driver is plain /dev/fb0 writes with nothing
# that can wedge the board (no SPI overlay, no GPIO claims), so for that one
# device the driver comes up first and the boot steps are drawn on the panel
# as they happen. Every other display keeps the deliberate late init below.

const bootScreenDevices = ["framebuffer"]
const bootMarkCycleSeconds = 6.0
var driversInitialized = false
# The last status drawn, redrawn by bootScreenTick with the next animation
# frame while the network check waits; and how long that draw took, which
# paces the ticks (with the driver's own time from render_stats).
var lastBootStatus = ""
var lastBootDrawSeconds = 0.0
# One canvas for the whole boot: a 1080p RGBA image is 8 MB, and the
# animation would otherwise allocate one per frame.
var bootCanvas: Image = nil

proc bootScreenSupported*(frameConfig: FrameConfig): bool =
  frameConfig.device in bootScreenDevices

proc initDriversOnce(self: FrameOS) =
  if driversInitialized:
    return
  driversInitialized = true
  drivers.init(self)
  # A driver that probed the panel (framebuffer, HyperPixel) has overwritten
  # width/height in memory; make frame.json and the cloud's hardware report
  # say the same thing.
  discard persistDetectedDisplaySize(self.frameConfig, self.logger)

proc bootMarkPhase*(epoch: float): float =
  ## Time-based animation phase (same cycle as system/index): a slow board
  ## steps through the cycle a fast one glides through. Never exactly 0
  ## while animating — 0 is the static logo.
  let phase = (epoch mod bootMarkCycleSeconds) / bootMarkCycleSeconds
  if phase <= 0: 1.0 / markPhaseSteps.float else: phase

proc bootScreen*(frameConfig: FrameConfig, status: string, markPhase = 0.0): StatusScreen =
  ## The boot variant of the shared status screen: the facts known before
  ## the network is up, and what the frame is doing right now.
  let deviceName = if frameConfig.name.len > 0: frameConfig.name else: "Unnamed frame"
  let deviceType = if frameConfig.device.len > 0: frameConfig.device else: "unknown device"
  let version = publishedFrameOSVersion(compiledFrameOSVersion())
  result = StatusScreen(
    status: status,
    rows: @[
      ("Name", deviceName),
      ("Device", &"{deviceType} · {frameConfig.width}×{frameConfig.height}"),
      ("Time zone", frameConfig.timeZone),
    ],
    footer: if version.len == 0 or version == "unknown": "FrameOS" else: "FrameOS v" & version,
    dark: true,
    markPhase: markPhase,
  )

proc renderBootScreen*(self: FrameOS, status: string, log = true) =
  ## Draws `status` on the panel now. Best effort: a failure here is logged
  ## and boot carries on — the screen is a courtesy, not a step.
  if not bootScreenSupported(self.frameConfig):
    return
  lastBootStatus = status
  try:
    self.initDriversOnce()
    let config = self.frameConfig
    let width = config.renderWidth()
    let height = config.renderHeight()
    if bootCanvas.isNil or bootCanvas.width != width or bootCanvas.height != height:
      bootCanvas = newImage(width, height)
    let drawTimer = getMonoTime()
    drawStatusScreen(bootCanvas, bootScreen(config, status, bootMarkPhase(epochTime())))
    # rotateDegrees/flip copy, so the canvas itself is never rotated twice.
    var image = bootCanvas
    case config.flip:
    of "horizontal":
      image = image.copy()
      image.flipHorizontal()
    of "vertical":
      image = image.copy()
      image.flipVertical()
    of "both":
      image = image.copy()
      image.flipHorizontal()
      image.flipVertical()
    else: discard
    let rotated = if config.rotate == 0: image else: image.rotateDegrees(config.rotate)
    lastBootDrawSeconds = durationToSeconds(getMonoTime() - drawTimer)
    let driverTimer = getMonoTime()
    drivers.render(rotated)
    noteDriverRenderSeconds(durationToSeconds(getMonoTime() - driverTimer))
    if log:
      self.logger.log(%*{"event": "boot:screen", "status": status})
  except CatchableError as e:
    self.logger.log(%*{"event": "boot:screen:error", "status": status, "error": e.msg})

proc bootScreenTick*(self: FrameOS): float =
  ## One animation frame of the boot screen: redraws the last status with
  ## the mark's next colours and returns how long to wait before the next
  ## one — paced so drawing plus the framebuffer push stays around a fifth
  ## of the time on this board (render_stats.pacedRenderInterval). 0 when
  ## there is nothing to animate.
  if not bootScreenSupported(self.frameConfig) or lastBootStatus.len == 0:
    return 0.0
  self.renderBootScreen(lastBootStatus, log = false)
  pacedRenderInterval(lastBootDrawSeconds, lastDriverRenderSeconds())

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
  self.renderBootScreen("Starting up…")
  if bootScreenSupported(self.frameConfig):
    let frameOS = self
    netportal.networkCheckProgressHook = proc(status: string) {.gcsafe.} =
      {.gcsafe.}:
        frameOS.renderBootScreen(status)
    netportal.networkCheckTickHook = proc(): float {.gcsafe.} =
      {.gcsafe.}:
        frameOS.bootScreenTick()
  # Decide (and log) NetworkManager vs wpa_supplicant before anything touches
  # the radio, and let the supplicant backend rejoin its saved network.
  netportal.ensureNetworkBackendReady(self)

  var firstSceneId: Option[SceneId] = none(SceneId)
  # The boot hotspot needs a connectivity probe to decide whether to start,
  # so it runs the network check even when "wait for network" is switched off.
  let hotspotBootOnly = self.frameConfig.network.wifiHotspot == "bootOnly"
  if self.frameConfig.network.networkCheck or hotspotBootOnly:
    let connected = checkNetwork(self)
    netportal.networkCheckProgressHook = nil
    netportal.networkCheckTickHook = nil
    if connected:
      self.renderBootScreen("Network connected. Loading scenes…")
    elif hotspotBootOnly:
      self.renderBootScreen("No network. Starting the setup hotspot…")
    else:
      self.renderBootScreen("No network yet. Loading scenes…")
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
  # crash is counted by the boot guard on the next attempt. (Already up on
  # boot-screen devices — see initDriversOnce.)
  self.initDriversOnce()

  self.runner.start(firstSceneId)
  # The runner owns the panel from here; the boot canvas is dead weight.
  bootCanvas = nil

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

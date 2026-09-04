import pixie, json, linuxfb, posix, posix/termios, strformat
import std/exitprocs
import frameos/device_setup
import frameos/driver_context
import frameos/driver_render_hint
import frameos/utils/process

const DEVICE = "/dev/fb0"
const TTY_DEVICE = "/dev/tty0"
const FRAMEBUFFER_TTY_DEVICE = "/dev/tty1"
const KDSETMODE = 0x4B3A
const KD_GRAPHICS = 0x01
const KD_TEXT = 0x00
# vcgencmd talks to the VideoCore mailbox and can hang in uninterruptible
# sleep when the GPU firmware is wedged; never wait for it without a bound.
const DISPLAY_COMMAND_TIMEOUT_MS = 10 * 1000
# How soon to ask for another render while /dev/fb0 has no mode yet, and the
# ceiling that backoff climbs to. Two seconds is fast enough that a Pi 5 whose
# KMS fbdev registers after frameos started draws almost immediately; a minute
# is slow enough that a board with nothing plugged in costs one ioctl a minute.
const PROBE_RETRY_START_SECONDS = 2.0
const PROBE_RETRY_MAX_SECONDS = 60.0

var consoleClaimAttempted = false
var consoleModeClaimed = false
var consoleRestoreRegistered = false

proc runDisplayCommand(command: string): int =
  runShellWithParentStreams(command, timeoutMs = DISPLAY_COMMAND_TIMEOUT_MS).exitCode

proc runPrivilegedDisplayShell(command: string): int =
  ## The sysfs knobs (cursor_blink, fb0/blank) are handed to the service
  ## group by frameos.service's ExecStartPre on Buildroot, so a plain write
  ## works there for the unprivileged runtime; root frames and sudo-capable
  ## Raspberry Pi OS users fall through to the privileged form.
  result = runDisplayCommand("sh -c " & shellQuote(command) & " 2>/dev/null")
  if result != 0:
    result = runDisplayCommand(privilegedCommand("sh -c " & shellQuote(command)))

type ScreenInfo* = object
  width*: uint32
  height*: uint32
  bitsPerPixel*: uint32
  lineLength*: uint32
  redOffset*: uint32
  redLength*: uint32
  greenOffset*: uint32
  greenLength*: uint32
  blueOffset*: uint32
  blueLength*: uint32
  alphaOffset*: uint32
  alphaLength*: uint32

type Driver* = ref object of FrameOSDriver
  screenInfo*: ScreenInfo
  logger*: DriverLogger
  sizeMismatchLogged*: bool
  # False when /dev/fb0 could not be interrogated at init. The screenInfo we
  # carry is then a fabrication (configuredScreenInfo), there is nothing to
  # write to, and render must bail before it so much as touches the image —
  # see the note on `render`.
  available*: bool
  unavailableLogged*: bool
  probeFailureLogged*: bool
  lastProbeError*: string
  # Seconds to ask the host to wait before the next probe. Doubles on every
  # failed pass up to PROBE_RETRY_MAX_SECONDS, resets once the panel answers.
  probeRetrySeconds*: float
  renderBuffer: seq[uint8]

proc logFrameBuffer(logger: DriverLogger, payload: JsonNode) =
  if not logger.isNil and not logger.log.isNil:
    logger.log(payload)

proc tryToDisableCursorBlinking() =
  let status = runPrivilegedDisplayShell("echo 0 > /sys/class/graphics/fbcon/cursor_blink")
  if status != 0:
    discard runPrivilegedDisplayShell("setterm -cursor off > " & shellQuote(FRAMEBUFFER_TTY_DEVICE))

proc disableTerminalEcho(fd: cint) =
  var state: Termios
  if tcGetAttr(fd, addr state) == 0:
    state.c_lflag = state.c_lflag and not (ECHO or ECHOE or ECHOK or ECHONL or ICANON)
    discard tcSetAttr(fd, TCSAFLUSH, addr state)

proc restoreTerminalEcho(fd: cint) =
  var state: Termios
  if tcGetAttr(fd, addr state) == 0:
    state.c_lflag = state.c_lflag or ECHO or ECHOE or ECHOK or ECHONL or ICANON
    discard tcSetAttr(fd, TCSAFLUSH, addr state)

proc setVirtualTerminalMode(fd: cint, mode: cint): bool =
  result = ioctl(fd, KDSETMODE, mode) == 0

proc setVirtualTerminalGraphicsMode(fd: cint): bool =
  result = setVirtualTerminalMode(fd, KD_GRAPHICS)
  if result:
    consoleModeClaimed = true
    disableTerminalEcho(fd)

proc setVirtualTerminalGraphicsMode(device: string): bool =
  let fd = open(device, O_RDWR)
  if fd < 0:
    return false
  try:
    result = setVirtualTerminalGraphicsMode(fd)
  finally:
    discard close(fd)

proc restoreVirtualTerminal(device: string): bool =
  let fd = open(device, O_RDWR)
  if fd < 0:
    return false
  try:
    restoreTerminalEcho(fd)
    result = setVirtualTerminalMode(fd, KD_TEXT)
  finally:
    discard close(fd)

proc restoreFramebufferConsole*() =
  if not consoleModeClaimed:
    return
  consoleModeClaimed = false

  if isatty(STDIN_FILENO) == 1:
    restoreTerminalEcho(STDIN_FILENO)
    discard setVirtualTerminalMode(STDIN_FILENO, KD_TEXT)
  for device in ["/dev/tty", FRAMEBUFFER_TTY_DEVICE, TTY_DEVICE]:
    discard restoreVirtualTerminal(device)

proc restoreFramebufferConsoleOnQuit() {.noconv.} =
  restoreFramebufferConsole()

proc restoreFramebufferConsoleSignal(sig: cint) {.noconv.} =
  restoreFramebufferConsole()
  signal(sig, SIG_DFL)
  discard kill(getpid(), sig)

proc registerConsoleRestore() =
  if consoleRestoreRegistered:
    return
  consoleRestoreRegistered = true
  addExitProc(restoreFramebufferConsoleOnQuit)
  signal(SIGTERM, restoreFramebufferConsoleSignal)
  signal(SIGINT, restoreFramebufferConsoleSignal)
  signal(SIGHUP, restoreFramebufferConsoleSignal)

proc setVirtualTerminalGraphicsMode(): bool =
  if isatty(STDIN_FILENO) == 1 and setVirtualTerminalGraphicsMode(STDIN_FILENO):
    return true
  for device in ["/dev/tty", TTY_DEVICE, FRAMEBUFFER_TTY_DEVICE]:
    if setVirtualTerminalGraphicsMode(device):
      return true

proc claimConsoleAfterSuccessfulRender(logger: DriverLogger) =
  if consoleClaimAttempted:
    return
  consoleClaimAttempted = true

  let graphicsMode = setVirtualTerminalGraphicsMode()
  if graphicsMode:
    registerConsoleRestore()
    logFrameBuffer(logger, %*{
        "event": "driver:frameBuffer:consoleClaimed",
        "graphicsMode": graphicsMode,
    })
    return

  logFrameBuffer(logger, %*{"event": "driver:frameBuffer:consoleClaim:error"})

proc getScreenInfo(logger: DriverLogger): ScreenInfo =
  let fd = open(DEVICE, O_RDWR)
  if fd < 0:
    raise newException(OSError, &"Unable to open framebuffer device {DEVICE}")
  try:
    var var_info: fb_var_screeninfo
    if ioctl(fd, FBIOGET_VSCREENINFO, addr var_info) != 0:
      raise newException(OSError, &"Unable to read framebuffer screen info from {DEVICE}")
    # A successful ioctl is not a valid mode. `/dev/fb0` exists before the KMS
    # driver has set one — and keeps existing when nothing is plugged in — and
    # then answers with a mode of all zeros. Callers treat a raise as "not
    # ready, keep the fallback and try again", and that is exactly what a
    # zero-sized screen is; accepting it instead latched a driver that logged
    # "Invalid framebuffer screen info" on every pass and never drew.
    if var_info.xres == 0 or var_info.yres == 0 or var_info.bits_per_pixel == 0:
      raise newException(OSError,
        &"Framebuffer device {DEVICE} reports no mode yet " &
        &"({var_info.xres}x{var_info.yres} @ {var_info.bits_per_pixel}bpp)")
    # The framebuffer can pad each row beyond xres * bytesPerPixel; writes must honor this stride
    var fix_info: fb_fix_screeninfo
    var lineLength = 0'u32
    if ioctl(fd, FBIOGET_FSCREENINFO, addr fix_info) == 0:
      lineLength = fix_info.line_length
    result = ScreenInfo(
      width: var_info.xres,
      height: var_info.yres,
      bitsPerPixel: var_info.bits_per_pixel,
      lineLength: lineLength,
      redOffset: var_info.red.offset,
      redLength: var_info.red.length,
      greenOffset: var_info.green.offset,
      greenLength: var_info.green.length,
      blueOffset: var_info.blue.offset,
      blueLength: var_info.blue.length,
      alphaOffset: var_info.transp.offset,
      alphaLength: var_info.transp.length,
    )
    logFrameBuffer(logger, %*{
        "event": "driver:frameBuffer",
        "screenInfo": result,
    })
  finally:
    discard close(fd)

proc configuredScreenInfo(frameOS: DriverContext): ScreenInfo =
  let configuredWidth =
    if not frameOS.isNil and not frameOS.frameConfig.isNil and frameOS.frameConfig.width > 0:
      frameOS.frameConfig.width.uint32
    else:
      0'u32
  let configuredHeight =
    if not frameOS.isNil and not frameOS.frameConfig.isNil and frameOS.frameConfig.height > 0:
      frameOS.frameConfig.height.uint32
    else:
      0'u32
  result = ScreenInfo(
    width: configuredWidth,
    height: configuredHeight,
    bitsPerPixel: 32,
    lineLength: configuredWidth * 4,
    redOffset: 16,
    redLength: 8,
    greenOffset: 8,
    greenLength: 8,
    blueOffset: 0,
    blueLength: 8,
    alphaOffset: 24,
    alphaLength: 8,
  )

proc init*(frameOS: DriverContext): Driver =
  let logger = if frameOS.isNil: nil else: frameOS.logger
  var screenInfo: ScreenInfo
  var available = true
  var probeError = ""
  try:
    tryToDisableCursorBlinking()
    screenInfo = getScreenInfo(logger)
  except DivByZeroDefect as e:
    available = false
    probeError = e.msg
    screenInfo = configuredScreenInfo(frameOS)
    logFrameBuffer(logger, %*{"event": "driver:frameBuffer",
        "error": "Invalid framebuffer metadata caused division by zero",
        "exception": e.msg,
        "fallbackScreenInfo": screenInfo})
  except Exception as e:
    available = false
    probeError = e.msg
    screenInfo = configuredScreenInfo(frameOS)
    logFrameBuffer(logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace(), "fallbackScreenInfo": screenInfo})

  # Update the frameOS config
  if not frameOS.isNil and not frameOS.frameConfig.isNil and screenInfo.width > 0 and screenInfo.height > 0:
    frameOS.frameConfig.width = screenInfo.width.int
    frameOS.frameConfig.height = screenInfo.height.int

  result = Driver(
    name: "frameBuffer",
    screenInfo: screenInfo,
    logger: logger,
    available: available,
    lastProbeError: probeError,
    probeRetrySeconds: PROBE_RETRY_START_SECONDS,
  )

proc publishScreenSize*(self: Driver) =
  ## Hands the probed geometry to the host through the driver→host hint
  ## channel (frameos/driver_render_hint; polled after every render). A
  ## frame.json that says 800x480 (the generic image default) on a 1080p HDMI
  ## panel is what every new cloud card ships with; the host persists what we
  ## report (frameos/display_detect) so scenes, the cloud and the next boot
  ## agree. No host ref is kept here — see frameos/driver_abi.
  if self.isNil:
    return
  if self.screenInfo.width > 0 and self.screenInfo.height > 0:
    reportDetectedDisplaySize(self.screenInfo.width.int, self.screenInfo.height.int)

proc setup*(frameOS: DriverContext = nil): SetupResult =
  if frameOS.isNil or frameOS.frameConfig.isNil:
    setupLog("FrameOS setup: frameBuffer: driver context unavailable; skipping framebuffer dimension detection")
    return setupOk()

  try:
    let screenInfo = getScreenInfo(frameOS.logger)
    if screenInfo.width > 0 and screenInfo.height > 0:
      frameOS.frameConfig.width = screenInfo.width.int
      frameOS.frameConfig.height = screenInfo.height.int
      setupLog("FrameOS setup: frameBuffer: detected " & $screenInfo.width & "x" & $screenInfo.height &
        " @ " & $screenInfo.bitsPerPixel & "bpp")
    else:
      setupLog("FrameOS setup: frameBuffer: detected invalid framebuffer dimensions")
  except DivByZeroDefect as e:
    setupLog("FrameOS setup: frameBuffer: invalid framebuffer metadata caused division by zero: " & e.msg)
  except Exception as e:
    setupLog("FrameOS setup: frameBuffer: could not detect framebuffer dimensions: " & e.msg)
  result = setupOk()

proc render*(self: Driver, image: Image) =
  if self.isNil:
    return

  # A failed probe at init is not a permanent verdict. On a Pi 5 the KMS
  # driver registers its fbdev after frameos has already started, so a driver
  # that latched "no framebuffer" at init would sit dark forever on a board
  # whose display works perfectly a second later. Retry the cheap probe until
  # it lands; it also upgrades the fabricated screenInfo to the panel's real
  # geometry.
  if not self.available:
    try:
      self.screenInfo = getScreenInfo(self.logger)
      self.available = true
      self.probeFailureLogged = false
      self.probeRetrySeconds = PROBE_RETRY_START_SECONDS
      self.publishScreenSize()
    except DivByZeroDefect as e:
      self.lastProbeError = e.msg
    except Exception as e:
      self.lastProbeError = e.msg

  # Nothing to draw on until a probe lands: the screenInfo we hold is
  # configuredScreenInfo's fabrication, and writing an invented stride into a
  # device that has never described itself is a shot in the dark. Say so once,
  # and ask the host to come back before the scene's own interval would — a
  # frame on an hour-long interval would otherwise sit blank for an hour after
  # a boot that was seconds from working (frameos/driver_render_hint). The
  # backoff keeps a permanently headless board down to one cheap ioctl a
  # minute instead of one every few seconds, forever.
  if not self.available:
    # Guard rather than trust the field: the HyperPixel drivers subclass this
    # Driver and build it themselves, so an unset (0.0) backoff would ask to
    # be called back immediately, forever.
    if self.probeRetrySeconds <= 0:
      self.probeRetrySeconds = PROBE_RETRY_START_SECONDS
    requestEarlierRender(self.probeRetrySeconds)
    self.probeRetrySeconds = min(self.probeRetrySeconds * 2, PROBE_RETRY_MAX_SECONDS)
    if not self.probeFailureLogged:
      self.probeFailureLogged = true
      logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
          "error": "Framebuffer not ready, skipping renders until it is",
          "device": DEVICE,
          "probeError": self.lastProbeError,
          "hint": "On a Pi 5 the firmware provides no framebuffer of its own " &
            "(bcm2708_fb is Pi 1-4 only); config.txt needs dtoverlay=vc4-kms-v3d. " &
            "A fb0 that answers with a 0x0 mode has no display attached yet."})
    return

  let bitsPerPixel = self.screenInfo.bitsPerPixel
  if self.screenInfo.width == 0 or self.screenInfo.height == 0 or bitsPerPixel == 0:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Invalid framebuffer screen info",
        "screenInfo": self.screenInfo})
    return
  if bitsPerPixel != 16 and bitsPerPixel != 24 and bitsPerPixel != 32:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Unsupported bits per pixel",
        "bpp": bitsPerPixel})
    return

  let width = self.screenInfo.width.int
  let height = self.screenInfo.height.int
  let bytesPerPixel = int(bitsPerPixel) div 8
  let rowBytes = width * bytesPerPixel
  # The framebuffer can pad each row; skip the padding bytes when writing
  let lineLength = if self.screenInfo.lineLength.int >= rowBytes: self.screenInfo.lineLength.int
    else: rowBytes
  let bufferLen = lineLength * height

  # Open the device BEFORE touching `image`, and bail here if it will not
  # open. This driver is a shared library carrying its own ARC runtime: the
  # moment it takes an owning reference to a pixie object the host allocated,
  # two cycle collectors are bookkeeping one object, and the HOST dies later
  # releasing the image at the end of its render loop — SIGSEGV in
  # unregisterCycle, from a stack that names only runner.nim. A Pi 5 with no
  # writable framebuffer crash-looped on exactly that, fourteen restarts in
  # two minutes. No device, no reference, no crash.
  var fb: File
  if not open(fb, DEVICE, fmWrite, bufferLen):
    if not self.unavailableLogged:
      self.unavailableLogged = true
      logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
          "error": "Cannot open " & DEVICE & " for writing, skipping renders",
          "device": DEVICE,
          "hint": "On a Pi 5 the firmware provides no framebuffer of its own " &
            "(bcm2708_fb is Pi 1-4 only); config.txt needs dtoverlay=vc4-kms-v3d."})
    return
  self.unavailableLogged = false

  try:
    # Deliberately NOT `var renderImage = image`: that is an owning copy of
    # the host's ref, and the hazard described above. Read the host's pixels
    # through a raw view instead, and only allocate here when the panel
    # geometry forces a resize (that image is ours, so owning it is fine).
    var scaled: Image = nil
    if image.width != width or image.height != height:
      if not self.sizeMismatchLogged:
        self.sizeMismatchLogged = true
        logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
            "warning": "Rendered image does not match framebuffer resolution, scaling to fit",
            "imageWidth": image.width, "imageHeight": image.height,
            "screenInfo": self.screenInfo})
      scaled = image.resize(width, height)
    let source = if scaled.isNil: image else: scaled
    if source.width * source.height == 0:
      return
    let pixels = cast[ptr UncheckedArray[ColorRGBX]](unsafeAddr source.data[0])

    # The conversion below is the runtime's hottest loop on an HDMI frame
    # (2 M pixels a frame at 1080p, several frames a second while the status
    # screen animates), so it runs on raw pointers with the layout decided
    # once per frame, not per pixel. Every byte of the buffer is written by
    # the loops (padding included), so no zeroing pass either.
    if self.renderBuffer.len != bufferLen:
      self.renderBuffer = newSeq[uint8](bufferLen)
    let buffer = cast[ptr UncheckedArray[uint8]](addr self.renderBuffer[0])
    let padding = lineLength - rowBytes
    if bitsPerPixel == 16:
      for y in 0 ..< height:
        var j = y * lineLength
        let row = y * width
        for x in 0 ..< width:
          let color = pixels[row + x]
          let pixel = ((uint16(color.r) shr 3) shl 11) or ((uint16(
              color.g) shr 2) shl 5) or (uint16(color.b) shr 3)
          buffer[j] = uint8(pixel and 0xff)
          buffer[j + 1] = uint8(pixel shr 8)
          j += 2
        if padding > 0:
          zeroMem(addr buffer[j], padding)
    else:
      let redByte = int(self.screenInfo.redOffset) div 8
      let greenByte = int(self.screenInfo.greenOffset) div 8
      let blueByte = int(self.screenInfo.blueOffset) div 8
      let alphaByte = int(self.screenInfo.alphaOffset) div 8
      # A 32bpp framebuffer with no alpha channel (the common Pi case) still
      # has a fourth byte per pixel; it is written as 0 rather than left to a
      # separate zeroing pass over the whole buffer.
      let hasAlpha = self.screenInfo.alphaLength > 0
      let fillByte = if bytesPerPixel == 4 and not hasAlpha:
          6 - redByte - greenByte - blueByte # the one offset not taken by a colour
        else: -1
      for y in 0 ..< height:
        var j = y * lineLength
        let row = y * width
        if hasAlpha:
          for x in 0 ..< width:
            let color = pixels[row + x]
            buffer[j + redByte] = color.r
            buffer[j + greenByte] = color.g
            buffer[j + blueByte] = color.b
            buffer[j + alphaByte] = color.a
            j += bytesPerPixel
        elif fillByte >= 0:
          for x in 0 ..< width:
            let color = pixels[row + x]
            buffer[j + redByte] = color.r
            buffer[j + greenByte] = color.g
            buffer[j + blueByte] = color.b
            buffer[j + fillByte] = 0
            j += 4
        else:
          for x in 0 ..< width:
            let color = pixels[row + x]
            buffer[j + redByte] = color.r
            buffer[j + greenByte] = color.g
            buffer[j + blueByte] = color.b
            j += bytesPerPixel
        if padding > 0:
          zeroMem(addr buffer[j], padding)

    discard fb.writeBuffer(addr self.renderBuffer[0], self.renderBuffer.len)
    fb.flushFile()
    claimConsoleAfterSuccessfulRender(self.logger)
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to write image to " & DEVICE})
  finally:
    fb.close()

proc turnOn*(self: Driver) =
  try:
    let response = runDisplayCommand("vcgencmd display_power 1")
    if response != 0:
      discard runPrivilegedDisplayShell("echo 0 > /sys/class/graphics/fb0/blank")
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to turn display on"})

proc turnOff*(self: Driver) =
  try:
    let response = runDisplayCommand("vcgencmd display_power 0")
    if response != 0:
      discard runPrivilegedDisplayShell("echo 1 > /sys/class/graphics/fb0/blank")
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to turn display off"})

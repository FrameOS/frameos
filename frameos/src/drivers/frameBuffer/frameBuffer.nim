import pixie, json, linuxfb, posix, posix/termios, strformat
import std/exitprocs
import frameos/device_setup
import frameos/driver_context
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

var consoleClaimAttempted = false
var consoleModeClaimed = false
var consoleRestoreRegistered = false

proc runDisplayCommand(command: string): int =
  runShellWithParentStreams(command, timeoutMs = DISPLAY_COMMAND_TIMEOUT_MS).exitCode

proc runPrivilegedDisplayShell(command: string): int =
  runDisplayCommand(privilegedCommand("sh -c " & shellQuote(command)))

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
  try:
    tryToDisableCursorBlinking()
    screenInfo = getScreenInfo(logger)
  except Exception as e:
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
  )

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
  except Exception as e:
    setupLog("FrameOS setup: frameBuffer: could not detect framebuffer dimensions: " & e.msg)
  result = setupOk()

proc render*(self: Driver, image: Image) =
  if self.isNil:
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
  var renderImage = image
  if image.width != width or image.height != height:
    if not self.sizeMismatchLogged:
      self.sizeMismatchLogged = true
      logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
          "warning": "Rendered image does not match framebuffer resolution, scaling to fit",
          "imageWidth": image.width, "imageHeight": image.height,
          "screenInfo": self.screenInfo})
    renderImage = image.resize(width, height)
  let imageData = renderImage.data

  let bytesPerPixel = int(bitsPerPixel) div 8
  let rowBytes = width * bytesPerPixel
  # The framebuffer can pad each row; skip the padding bytes when writing
  let lineLength = if self.screenInfo.lineLength.int >= rowBytes: self.screenInfo.lineLength.int
    else: rowBytes
  try:
    var buffer: seq[uint8] = newSeq[uint8](lineLength * height)
    if bitsPerPixel == 16:
      for y in 0 ..< height:
        var j = y * lineLength
        for x in 0 ..< width:
          let color = imageData[y * width + x]
          let pixel = ((uint16(color.r) shr 3) shl 11) or ((uint16(
              color.g) shr 2) shl 5) or (uint16(color.b) shr 3)
          buffer[j] = uint8(pixel and 0xff)
          buffer[j + 1] = uint8(pixel shr 8)
          j += 2
    else:
      let redByte = int(self.screenInfo.redOffset) div 8
      let greenByte = int(self.screenInfo.greenOffset) div 8
      let blueByte = int(self.screenInfo.blueOffset) div 8
      let alphaByte = int(self.screenInfo.alphaOffset) div 8
      for y in 0 ..< height:
        var j = y * lineLength
        for x in 0 ..< width:
          let color = imageData[y * width + x]
          buffer[j + redByte] = color.r
          buffer[j + greenByte] = color.g
          buffer[j + blueByte] = color.b

          # Framebuffer could be 32bpp with 0 length alpha (effectively 24bpp)
          # or 24bpp with 0 length alpha
          if self.screenInfo.alphaLength > 0:
            buffer[j + alphaByte] = color.a
          j += bytesPerPixel

    var fb = open(DEVICE, fmWrite, buffer.len)
    discard fb.writeBuffer(addr buffer[0], buffer.len)
    fb.close()
    claimConsoleAfterSuccessfulRender(self.logger)
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

proc turnOn*(self: Driver) =
  try:
    let response = runDisplayCommand("vcgencmd display_power 1")
    if response != 0:
      discard runDisplayCommand("sudo sh -c 'echo 0 > /sys/class/graphics/fb0/blank'")
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to turn display on"})

proc turnOff*(self: Driver) =
  try:
    let response = runDisplayCommand("vcgencmd display_power 0")
    if response != 0:
      discard runDisplayCommand("sudo sh -c 'echo 1 > /sys/class/graphics/fb0/blank'")
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to turn display off"})

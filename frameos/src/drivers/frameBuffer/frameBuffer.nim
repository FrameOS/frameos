import pixie, json, linuxfb, posix, strformat, osproc
import frameos/device_setup
import frameos/driver_context

const DEVICE = "/dev/fb0"

type ScreenInfo* = object
  width*: uint32
  height*: uint32
  bitsPerPixel*: uint32
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

proc logFrameBuffer(logger: DriverLogger, payload: JsonNode) =
  if not logger.isNil and not logger.log.isNil:
    logger.log(payload)

proc tryToDisableCursorBlinking() =
  let status = execCmd("echo 0 | sudo tee /sys/class/graphics/fbcon/cursor_blink")
  if status != 0:
    discard execCmd("sudo sh -c 'setterm -cursor off > /dev/tty0'")

proc getScreenInfo(logger: DriverLogger): ScreenInfo =
  let fd = open(DEVICE, O_RDWR)
  if fd < 0:
    raise newException(OSError, &"Unable to open framebuffer device {DEVICE}")
  try:
    var var_info: fb_var_screeninfo
    if ioctl(fd, FBIOGET_VSCREENINFO, addr var_info) != 0:
      raise newException(OSError, &"Unable to read framebuffer screen info from {DEVICE}")
    result = ScreenInfo(
      width: var_info.xres,
      height: var_info.yres,
      bitsPerPixel: var_info.bits_per_pixel,
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
  let imageData = image.data
  let bitsPerPixel = self.screenInfo.bitsPerPixel
  if self.screenInfo.width == 0 or self.screenInfo.height == 0 or bitsPerPixel == 0:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Invalid framebuffer screen info",
        "screenInfo": self.screenInfo})
    return
  try:
    var fb = open(DEVICE, fmWrite, (self.screenInfo.width *
          self.screenInfo.height * bitsPerPixel div 8).int)
    if bitsPerPixel == 16:
      var
        buffer: seq[uint16] = newSeq[uint16](len(imageData))
      for i, color in imageData:
        buffer[i] = ((uint16(color.r) shr 3) shl 11) or ((uint16(
            color.g) shr 2) shl 5) or (uint16(color.b) shr 3)
      discard fb.writeBuffer(addr buffer[0], buffer.len * sizeof(uint16))
    elif bitsPerPixel == 24 or bitsPerPixel == 32:
      var bytesPerPixel = int(bitsPerPixel shr 3) # 24bpp = 3, 32bpp = 4
      var buffer: seq[uint8] = newSeq[uint8](len(imageData) * bytesPerPixel)
      for i, color in imageData:
        let j = i * bytesPerPixel
        buffer[j + int(self.screenInfo.redOffset) div 8] = color.r
        buffer[j + int(self.screenInfo.greenOffset) div 8] = color.g
        buffer[j + int(self.screenInfo.blueOffset) div 8] = color.b

        # Framebuffer could be 32bpp with 0 length alpha (effectively 24bpp)
        # or 24bpp with 0 length alpha
        if self.screenInfo.alphaLength > 0:
          buffer[j + int(self.screenInfo.alphaOffset) div 8] = color.a

      discard fb.writeBytes(buffer, 0, len(buffer))
    else:
      logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
          "error": "Unsupported bits per pixel",
          "bpp": bitsPerPixel})
    fb.close()
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

proc turnOn*(self: Driver) =
  try:
    let response = execCmd("vcgencmd display_power 1")
    if response != 0:
      discard execCmd("sudo sh -c 'echo 0 > /sys/class/graphics/fb0/blank'")
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to turn display on"})

proc turnOff*(self: Driver) =
  try:
    let response = execCmd("vcgencmd display_power 0")
    if response != 0:
      discard execCmd("sudo sh -c 'echo 1 > /sys/class/graphics/fb0/blank'")
  except:
    logFrameBuffer(self.logger, %*{"event": "driver:frameBuffer",
        "error": "Failed to turn display off"})

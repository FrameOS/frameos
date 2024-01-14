import pixie, json, linuxfb, posix, strformat, osproc
import frameos/types

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

type ColorBGRA = object
  b, g, r, a: uint8

type Driver* = ref object of FrameOSDriver
  screenInfo: ScreenInfo
  logger: Logger

proc tryToDisableCursorBlinking() =
  let status = execCmd("echo 0 | sudo tee /sys/class/graphics/fbcon/cursor_blink")
  if status != 0:
    discard execCmd("sudo sh -c 'setterm -cursor off > /dev/tty0'")

proc getScreenInfo(logger: Logger): ScreenInfo =
  let fd = open(DEVICE, O_RDWR)
  var var_info: fb_var_screeninfo
  discard ioctl(fd, FBIOGET_VSCREENINFO, addr var_info)
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
  logger.log(%*{
      "event": "driver:frameBuffer",
      "screenInfo": result,
  })
  discard close(fd)

proc init*(frameOS: FrameOS): Driver =
  let logger = frameOS.logger
  try:
    var res: Stat
    discard stat(DEVICE, res)
  except OSError:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver",
        "message": &"Framebuffer device {DEVICE} not found"})

  try:
    tryToDisableCursorBlinking()
    let screenInfo = getScreenInfo(logger)

    # Update the frameOS config
    if screenInfo.width > 0 and screenInfo.height > 0:
      frameOS.frameConfig.width = screenInfo.width.int
      frameOS.frameConfig.height = screenInfo.height.int

    result = Driver(
      name: "frameBuffer",
      screenInfo: screenInfo,
      logger: logger,
    )
  except Exception as e:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc render*(self: Driver, image: Image) =
  let imageData = image.data
  try:
    var fb = open(DEVICE, fmWrite, (self.screenInfo.width *
          self.screenInfo.height * self.screenInfo.bitsPerPixel div 8).int)
    if self.screenInfo.bitsPerPixel == 16:
      var
        buffer: seq[uint16] = newSeq[uint16](len(imageData))
      for i, color in imageData:
        buffer[i] = ((uint16(color.r) shr 3) shl 11) or ((uint16(
            color.g) shr 2) shl 5) or (uint16(color.b) shr 3)
      discard fb.writeBuffer(addr buffer[0], buffer.len * sizeof(uint16))
    elif self.screenInfo.bitsPerPixel == 32:
      if self.screenInfo.blueOffset < self.screenInfo.greenOffset and
          self.screenInfo.greenOffset < self.screenInfo.redOffset and
          self.screenInfo.redOffset < self.screenInfo.alphaOffset:
        var
          buffer: seq[uint8] = newSeq[uint8](len(imageData) * sizeof(ColorBGRA))
        for i, color in imageData:
          let j = i * 4
          buffer[j] = color.b
          buffer[j + 1] = color.g
          buffer[j + 2] = color.r
          buffer[j + 3] = color.a
        discard fb.writeBytes(buffer, 0, len(buffer))
      else:
        discard fb.writeBuffer(addr imageData[0], sizeof(imageData))
    else:
      self.logger.log(%*{"event": "driver:frameBuffer",
          "error": "Unsupported bits per pixel",
          "bpp": self.screenInfo.bitsPerPixel})
    fb.close()
  except:
    self.logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

proc turnOn*(self: Driver) =
  try:
    let response = execCmd("vcgencmd display_power 1")
    if response != 0:
      discard execCmd("sudo sh -c 'echo 0 > /sys/class/graphics/fb0/blank'")
  except:
    self.logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to turn display on"})

proc turnOff*(self: Driver) =
  try:
    let response = execCmd("vcgencmd display_power 0")
    if response != 0:
      discard execCmd("sudo sh -c 'echo 1 > /sys/class/graphics/fb0/blank'")
  except:
    self.logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to turn display off"})

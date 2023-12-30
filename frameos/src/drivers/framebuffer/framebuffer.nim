import pixie, json, linuxfb, posix, strformat, sequtils, osproc

from frameos/types import Logger, FrameOSDriver

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
  transpOffset*: uint32
  transpLength*: uint32

type Driver* = ref object of FrameOSDriver
  screenInfo: ScreenInfo
  logger: Logger

proc tryToDisableCursorBlinking() =
  try:
    discard execCmd("echo 0 | sudo tee /sys/class/graphics/fbcon/cursor_blink")
  except:
    try:
      discard execCmd("sudo sh -c 'setterm -cursor off > /dev/tty0'")
    except:
      discard # We tried

proc init*(logger: Logger): Driver =
  try:
    var res: Stat
    discard stat(DEVICE, res)
  except OSError:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver",
        "message": &"Framebuffer device {DEVICE} not found"})

  tryToDisableCursorBlinking()

  try:
    let fd = open(DEVICE, O_RDWR)
    var var_info: fb_var_screeninfo
    discard ioctl(fd, FBIOGET_VSCREENINFO, addr var_info)
    let screenInfo = ScreenInfo(
      width: var_info.xres,
      height: var_info.yres,
      bitsPerPixel: var_info.bits_per_pixel,
      redOffset: var_info.red.offset,
      redLength: var_info.red.length,
      greenOffset: var_info.green.offset,
      greenLength: var_info.green.length,
      blueOffset: var_info.blue.offset,
      blueLength: var_info.blue.length,
      transpOffset: var_info.transp.offset,
      transpLength: var_info.transp.length,
    )
    logger.log(%*{
        "event": "driver:frameBuffer",
        "screenInfo": screenInfo,
    })
    discard close(fd)
    result = Driver(
      name: "frameBuffer",
      screenInfo: screenInfo,
      logger: logger,
    )
  except Exception as e:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc to16BitRGB(color: ColorRGBX): uint16 =
  let
    r = uint16(color.r shr 3) # Scale down to 5 bits
    g = uint16(color.g shr 2) # Scale down to 6 bits
    b = uint16(color.b shr 3) # Scale down to 5 bits
  return (r shl 11) or (g shl 5) or b # Combine the channels


proc render*(self: Driver, image: Image) =
  let imageData = image.data
  try:
    var fb = open(DEVICE, fmWrite, (self.screenInfo.width *
          self.screenInfo.height * self.screenInfo.bitsPerPixel div 8).int)
    if self.screenInfo.bitsPerPixel == 16:
      for color in imageData.map(to16BitRGB):
        discard fb.writeBuffer(addr color, sizeof(color))
    elif self.screenInfo.bitsPerPixel == 32:
      discard fb.writeBuffer(addr imageData, sizeof(imageData))
    else:
      self.logger.log(%*{"event": "driver:frameBuffer",
          "error": "Unsupported bits per pixel",
          "bpp": self.screenInfo.bitsPerPixel})
    fb.close()
  except:
    self.logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

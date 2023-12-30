import pixie, json, linuxfb, posix, strformat

from frameos/types import Logger, FrameOSDriver

const DEVICE = "/dev/fb0"

type ScreenInfo* = object
  width*: uint32
  height*: uint32
  bpp*: uint32
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

proc init*(logger: Logger): Driver =
  try:
    var res: Stat
    discard stat(DEVICE, res)
  except OSError:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver",
        "message": &"Framebuffer device {DEVICE} not found"})

  try:
    let fd = open(DEVICE, O_RDWR)
    var var_info: fb_var_screeninfo
    discard ioctl(fd, FBIOGET_VSCREENINFO, addr var_info)
    let screenInfo = ScreenInfo(
      width: var_info.xres,
      height: var_info.yres,
      bpp: var_info.bits_per_pixel,
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

proc render*(self: Driver, image: Image) =
  let imageData = image.data
  try:
    writeFile(DEVICE, $imageData)
  except:
    self.logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

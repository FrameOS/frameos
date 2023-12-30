import pixie, json, linuxfb, posix, strformat

from frameos/types import Logger

const DEVICE = "/dev/fb0"

proc init*(logger: Logger) =
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
    logger.log(%*{
        "event": "driver:frameBuffer",
        "width": var_info.xres,
        "height": var_info.yres,
        "bpp": var_info.bits_per_pixel,
        "redOffset": var_info.red.offset,
        "redLength": var_info.red.length,
        "greenOffset": var_info.green.offset,
        "greenLength": var_info.green.length,
        "blueOffset": var_info.blue.offset,
        "blueLength": var_info.blue.length,
        "transpOffset": var_info.transp.offset,
        "transpLength": var_info.transp.length,
    })
    discard close(fd)
  except Exception as e:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc render*(logger: Logger, image: Image) =
  let imageData = image.data
  try:
    writeFile(DEVICE, $imageData)
  except:
    logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

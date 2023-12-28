import pixie, json

from frameos/types import FrameOS, FrameConfig, Logger
from frameos/logger import log

proc render*(frameOS: FrameOS, image: Image) =
  let imageData = image.data
  try:
    writeFile("/dev/fb0", $imageData)
  except:
    frameos.logger.log(%*{"event": "driver:frameBuffer",
        "error": "Failed to write image to /dev/fb0"})

import std/json

import frameos/types
import drivers/gpioButton/gpioButton as gpioButtonImpl

proc frameosDriverInit*(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.exportc, dynlib.} =
  discard config
  return gpioButtonImpl.init(frameOS)

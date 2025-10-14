import std/json

import frameos/types
import drivers/evdev/evdev as evdevImpl

proc frameosDriverInit*(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.exportc, dynlib.} =
  discard config
  return evdevImpl.init(frameOS)

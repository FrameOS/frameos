import std/json
import pixie

import frameos/types
import drivers/inkyPython/inkyPython as inkyImpl

template asInky(driver: FrameOSDriver): inkyImpl.Driver =
  cast[inkyImpl.Driver](driver)

proc frameosDriverInit*(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.exportc, dynlib.} =
  discard config
  return inkyImpl.init(frameOS)

proc frameosDriverRender*(driver: FrameOSDriver, image: Image) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asInky(driver).render(image)

proc frameosDriverToPng*(driver: FrameOSDriver, rotate: int): string {.exportc, dynlib.} =
  discard driver
  return inkyImpl.toPng(rotate)

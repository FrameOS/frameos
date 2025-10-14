import std/json
import pixie

import frameos/types
import drivers/inkyHyperPixel2r/inkyHyperPixel2r as hyperPixelImpl

template asHyperPixel(driver: FrameOSDriver): hyperPixelImpl.Driver =
  cast[hyperPixelImpl.Driver](driver)

proc frameosDriverInit*(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.exportc, dynlib.} =
  discard config
  return hyperPixelImpl.init(frameOS)

proc frameosDriverRender*(driver: FrameOSDriver, image: Image) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asHyperPixel(driver).render(image)

proc frameosDriverTurnOn*(driver: FrameOSDriver) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asHyperPixel(driver).turnOn()

proc frameosDriverTurnOff*(driver: FrameOSDriver) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asHyperPixel(driver).turnOff()

import std/json
import pixie

import frameos/types
import drivers/frameBuffer/frameBuffer as frameBufferImpl

template asFrameBuffer(driver: FrameOSDriver): frameBufferImpl.Driver =
  cast[frameBufferImpl.Driver](driver)

proc frameosDriverInit*(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.exportc, dynlib.} =
  discard config
  return frameBufferImpl.init(frameOS)

proc frameosDriverRender*(driver: FrameOSDriver, image: Image) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asFrameBuffer(driver).render(image)

proc frameosDriverTurnOn*(driver: FrameOSDriver) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asFrameBuffer(driver).turnOn()

proc frameosDriverTurnOff*(driver: FrameOSDriver) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asFrameBuffer(driver).turnOff()

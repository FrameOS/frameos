import std/json
import pixie

import frameos/types
import drivers/waveshare/waveshare as waveshareImpl

template asWaveshare(driver: FrameOSDriver): waveshareImpl.Driver =
  cast[waveshareImpl.Driver](driver)

proc frameosDriverInit*(frameOS: FrameOS, config: JsonNode): FrameOSDriver {.exportc, dynlib.} =
  discard config
  return waveshareImpl.init(frameOS)

proc frameosDriverRender*(driver: FrameOSDriver, image: Image) {.exportc, dynlib.} =
  if driver.isNil:
    return
  asWaveshare(driver).render(image)

proc frameosDriverToPng*(driver: FrameOSDriver, rotate: int): string {.exportc, dynlib.} =
  discard driver
  return waveshareImpl.toPng(rotate)

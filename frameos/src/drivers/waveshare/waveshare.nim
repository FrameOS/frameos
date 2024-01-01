import pixie, json, linuxfb, posix, strformat, sequtils, osproc, os

from frameos/types import FrameOS, Logger, FrameOSDriver

import ePaper/DEV_Config as waveshareConfig
import ePaper/EPD_7in5_V2 as waveshare

type Driver* = ref object of FrameOSDriver
  logger: Logger
  width: int
  height: int


proc init*(frameOS: FrameOS): Driver =
  let logger = frameOS.logger
  let width = 800
  let height = 480

  let devInitResponse = waveshareConfig.DEV_Module_Init()
  if devInitResponse != 0:
    logger.log(%*{"event": "driver:waveshare", "devInit": "error",
        "responseCode": devInitResponse})

  let initResponse = waveshare.EPD_7IN5_V2_Init()
  if initResponse != 0:
    logger.log(%*{"event": "driver:waveshare", "init": "error",
      "EPD_7IN5_V2_Init": initResponse})

  waveshare.EPD_7IN5_V2_Clear()
  logger.log(%*{"event": "driver:waveshare", "clear": "done"})

  try:
    # Update the frameOS config
    if width > 0 and height > 0:
      frameOS.frameConfig.width = width
      frameOS.frameConfig.height = height

    result = Driver(
      name: "waveshare",
      logger: logger,
      width: width,
      height: height,
    )
  except Exception as e:
    logger.log(%*{"event": "driver:waveshare",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc render*(self: Driver, image: Image) =
  var packedImage = newSeq[uint8](ceil((image.width * image.height).float / 8).int)

  for y in 0..<image.height:
    for x in 0..<image.width:
      let index = y * image.width + x
      let pixel = image.data[index]

      let weightedSum = pixel.r * 299 + pixel.g * 587 + pixel.b * 114
      let bw: uint8 = if weightedSum < 128 * 1000: 0 else: 1

      packedImage[index div 8] = packedImage[index div 8] or (bw shl (index mod 8))

  waveshare.EPD_7IN5_V2_Display(addr packedImage[0])
  sleep(2000)

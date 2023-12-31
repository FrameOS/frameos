import pixie, json

from frameos/types import FrameOS, Logger, FrameOSDriver
from ./types import ColorOption
import driver as waveshareDriver

type Driver* = ref object of FrameOSDriver
  logger: Logger
  width: int
  height: int
  lastImageData: seq[ColorRGBX]

proc init*(frameOS: FrameOS): Driver =
  let logger = frameOS.logger
  let width = waveshareDriver.width
  let height = waveshareDriver.height

  logger.log(%*{"event": "driver:waveshare", "width": width, "height": height})
  waveshareDriver.init()

  try:
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

proc renderBlack*(self: Driver, image: Image) =
  let rowWidth = ceil(image.width.float / 8).int
  var blackImage = newSeq[uint8](rowWidth * image.height)

  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 8 + x
      let pixel = image.data[inputIndex]
      let weightedSum = pixel.r * 299 + pixel.g * 587 + pixel.b * 114
      let bw: uint8 = if weightedSum < 128 * 1000: 0 else: 1
      blackImage[index div 8] = blackImage[index div 8] or (bw shl (7 - (index mod 8)))

  waveshareDriver.renderImage(blackImage)

proc renderBlackRed*(self: Driver, image: Image) =
  let rowWidth = ceil(image.width.float / 8).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  var redImage = newSeq[uint8](rowWidth * image.height)

  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 8 + x
      let pixel = image.data[inputIndex]
      let weightedSum = pixel.r * 299 + pixel.g * 587 + pixel.b * 114
      let bw: uint8 = if weightedSum < 128 * 1000: 0 else: 1
      let red: uint8 = if pixel.r > 100 and pixel.g > 50 and pixel.b > 50: 1 else: 0
      blackImage[index div 8] = blackImage[index div 8] or (bw shl (7 - (index mod 8)))
      redImage[index div 8] = redImage[index div 8] or (red shl (7 - (index mod 8)))

  waveshareDriver.renderImageBlackRed(blackImage, redImage)

proc render4Gray*(self: Driver, image: Image) =
  raise newException(Exception, "4 gray mode not yet supported")

proc render7Color*(self: Driver, image: Image) =
  raise newException(Exception, "7 color mode not yet supported")

proc renderBWYR*(self: Driver, image: Image) =
  raise newException(Exception, "Black White Yellow Red mode not yet supported")

proc render*(self: Driver, image: Image) =
  if self.lastImageData == image.data:
    self.logger.log(%*{"event": "driver:waveshare",
        "info": "Skipping render, image data is the same"})
    return
  self.lastImageData = image.data

  case waveshareDriver.colorOption:
  of ColorOption.Black:
    self.renderBlack(image)
  of ColorOption.BlackRed:
    self.renderBlackRed(image)
  of ColorOption.SevenColor:
    self.render7Color(image)
  of ColorOption.FourGray:
    self.render4Gray(image)
  of ColorOption.BlackWhiteYellowRed:
    self.renderBWYR(image)

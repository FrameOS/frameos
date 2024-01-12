import pixie, json, times, os

import frameos/types
from ./types import ColorOption
import driver as waveshareDriver
import ./dither

type Driver* = ref object of FrameOSDriver
  logger: Logger
  width: int
  height: int
  lastImageData: seq[ColorRGBX]
  lastRenderAt: float

# TODO: make this configurable
const DEBUG = true

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
  # TODO: make dithering configurable
  var gray = grayscaleFloat(image)
  floydSteinberg(gray, image.width, image.height)

  let rowWidth = ceil(image.width.float / 8).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 8 + x
      let bw: uint8 = gray[inputIndex].uint8
      blackImage[index div 8] = blackImage[index div 8] or (bw shl (7 - (index mod 8)))
  waveshareDriver.renderImage(blackImage)

  if DEBUG:
    var outputImage = newImage(image.width, image.height)
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        let index = y * image.width + x
        outputImage.data[index].r = if gray[index] > 0.5: 255 else: 0
        outputImage.data[index].g = if gray[index] > 0.5: 255 else: 0
        outputImage.data[index].b = if gray[index] > 0.5: 255 else: 0
        outputImage.data[index].a = 255
    # TODO: output this over http somehow
    self.logger.log(%*{"event": "driver:waveshare", "message": "Writing debug image to /tmp/output.png"})
    outputImage.writeFile("/tmp/output.png")


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

proc renderFourGray*(self: Driver, image: Image) =
  # TODO: make dithering configurable
  var gray = grayscaleFloat(image, 3)
  floydSteinberg(gray, image.width, image.height)
  let rowWidth = ceil(image.width.float / 4).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 4 + x
      let bw: uint8 = gray[inputIndex].uint8 # 0, 1, 2 or 3
      blackImage[index div 4] = blackImage[index div 4] or ((bw and 0b11) shl (6 - (index mod 4) * 2))
  waveshareDriver.renderImage(blackImage)

  if DEBUG:
    var outputImage = newImage(image.width, image.height)
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        let index = y * image.width + x
        outputImage.data[index].r = (gray[index] / 3 * 255).uint8
        outputImage.data[index].g = (gray[index] / 3 * 255).uint8
        outputImage.data[index].b = (gray[index] / 3 * 255).uint8
        outputImage.data[index].a = 255
    # TODO: output this over http somehow
    self.logger.log(%*{"event": "driver:waveshare", "message": "Writing debug image to /tmp/output.png"})
    outputImage.writeFile("/tmp/output.png")

proc renderSevenColor*(self: Driver, image: Image) =
  raise newException(Exception, "7 color mode not yet supported")

proc renderBlackWhiteYellowRed*(self: Driver, image: Image) =
  raise newException(Exception, "Black White Yellow Red mode not yet supported")

proc render*(self: Driver, image: Image) =
  if self.lastImageData == image.data and self.lastRenderAt > epochTime() - 12 * 60 * 60:
    # refresh at least every 12h to preserve display
    # TODO: make this configurable
    self.logger.log(%*{"event": "driver:waveshare",
        "info": "Skipping render, image data is the same"})
    return

  self.lastImageData = image.data
  self.lastRenderAt = epochTime()
  waveshareDriver.start()

  case waveshareDriver.colorOption:
  of ColorOption.Black:
    self.renderBlack(image)
  of ColorOption.BlackRed:
    self.renderBlackRed(image)
  of ColorOption.SevenColor:
    self.renderSevenColor(image)
  of ColorOption.FourGray:
    self.renderFourGray(image)
  of ColorOption.BlackWhiteYellowRed:
    self.renderBlackWhiteYellowRed(image)

  waveshareDriver.sleep()

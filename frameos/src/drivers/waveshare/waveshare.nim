import pixie, json, times, locks

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

var
  lastFloatImageLock: Lock
  lastFloatImage: seq[float]

proc setAsLastFloatImage*(image: seq[float]) =
  withLock lastFloatImageLock:
    lastFloatImage = image

proc getLastFloatImage*(): seq[float] =
  withLock lastFloatImageLock:
    result = lastFloatImage

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
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray)
  gray.floydSteinberg(image.width, image.height)

  # The 7.5" waveshare frame displays weird artifacts without this. White colors bleed from top to bottom if these lines are not blanked
  # TODO: turn this into an option you can toggle on any frame
  if image.width == 800 and image.height == 480:
    for y in 0..<image.width:
      gray[y] = 1
      gray[y + image.width * (image.height - 1)] = 1

  gray.setAsLastFloatImage()

  let rowWidth = ceil(image.width.float / 8).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 8 + x
      let bw: uint8 = gray[inputIndex].uint8
      blackImage[index div 8] = blackImage[index div 8] or (bw shl (7 - (index mod 8)))
  waveshareDriver.renderImage(blackImage)

proc renderFourGray*(self: Driver, image: Image) =
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray, 3)
  gray.floydSteinberg(image.width, image.height)
  gray.setAsLastFloatImage()

  let rowWidth = ceil(image.width.float / 4).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 4 + x
      let bw: uint8 = gray[inputIndex].uint8 # 0, 1, 2 or 3
      blackImage[index div 4] = blackImage[index div 4] or ((bw and 0b11) shl (6 - (index mod 4) * 2))
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

proc renderSevenColor*(self: Driver, image: Image) =
  raise newException(Exception, "7 color mode not yet supported")

proc renderBlackWhiteYellowRed*(self: Driver, image: Image) =
  raise newException(Exception, "Black White Yellow Red mode not yet supported")

proc render*(self: Driver, image: Image) =
  # Refresh at least every 12h to preserve display
  # TODO: make this configurable
  if self.lastImageData == image.data and self.lastRenderAt > epochTime() - 12 * 60 * 60:
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

# Convert the rendered pixels to a PNG image. For accurate colors on the web.
proc toPng*(): string =
  let pixels = getLastFloatImage()
  var outputImage = newImage(width, height)
  case waveshareDriver.colorOption:
  of ColorOption.Black:
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        outputImage.data[index].r = (pixels[index] * 255).uint8
        outputImage.data[index].g = (pixels[index] * 255).uint8
        outputImage.data[index].b = (pixels[index] * 255).uint8
        outputImage.data[index].a = 255
  of ColorOption.FourGray:
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        outputImage.data[index].r = (pixels[index] * 85).uint8
        outputImage.data[index].g = (pixels[index] * 85).uint8
        outputImage.data[index].b = (pixels[index] * 85).uint8
        outputImage.data[index].a = 255
  of ColorOption.BlackRed:
    discard
  of ColorOption.SevenColor:
    discard
  of ColorOption.BlackWhiteYellowRed:
    discard

  return outputImage.encodeImage(PngFormat)

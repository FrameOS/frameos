import pixie, json, times, locks

import frameos/types
import frameos/utils/image
import frameos/utils/dither
import driver as waveshareDriver
import ./types

type Driver* = ref object of FrameOSDriver
  logger: Logger
  width: int
  height: int
  lastImageData: seq[ColorRGBX]
  lastRenderAt: float

var
  lastFloatImageLock: Lock
  lastFloatImage: seq[float] = @[]
  lastPixelsLock: Lock
  lastPixels: seq[uint8] = @[]

proc setLastFloatImage*(image: seq[float]) =
  withLock lastFloatImageLock:
    lastFloatImage = image

proc getLastFloatImage*(): seq[float] =
  withLock lastFloatImageLock:
    result = lastFloatImage

proc setLastPixels*(image: seq[uint8]) =
  withLock lastPixelsLock:
    lastPixels = image

proc getLastPixels*(): seq[uint8] =
  withLock lastPixelsLock:
    result = lastPixels

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

proc notifyImageAvailable*(self: Driver) =
  self.logger.log(%*{"event": "render:dither", "info": "Dithered image available"})

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

  setLastFloatImage(gray)
  self.notifyImageAvailable()

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
  setLastFloatImage(gray)
  self.notifyImageAvailable()

  let rowWidth = ceil(image.width.float / 4).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 4 + x
      let bw: uint8 = gray[inputIndex].uint8 # 0, 1, 2 or 3
      blackImage[index div 4] = blackImage[index div 4] or ((bw and 0b11) shl (6 - (index mod 4) * 2))
  waveshareDriver.renderImage(blackImage)

proc renderBlackWhiteRed*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, @[(0, 0, 0), (255, 0, 0), (255, 255, 255)])
  let rowWidth = ceil(image.width.float / 8).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  var redImage = newSeq[uint8](rowWidth * image.height)

  # TODO: save last pixels
  # TODO: notify image available

  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth + x div 8
      let oneByte = pixels[inputIndex div 2]
      let pixel = if inputIndex mod 2 == 0: oneByte shr 4 else: oneByte and 0x0F
      let bw: uint8 = if pixel == 0: 1 else: 0
      let red: uint8 = if pixel == 1: 1 else: 0
      blackImage[index] = blackImage[index] or (bw shl (7 - (x mod 8)))
      redImage[index] = redImage[index] or (red shl (7 - (x mod 8)))

  waveshareDriver.renderImageBlackWhiteRed(blackImage, redImage)

proc renderBlackWhiteYellowRed*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, saturated4ColorPalette)
  setLastPixels(pixels)
  self.notifyImageAvailable()
  waveshareDriver.renderImage(pixels)

proc renderSevenColor*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, saturated7ColorPalette)
  setLastPixels(pixels)
  self.notifyImageAvailable()
  waveshareDriver.renderImage(pixels)

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
  of ColorOption.BlackWhiteRed:
    self.renderBlackWhiteRed(image)
  of ColorOption.SevenColor:
    self.renderSevenColor(image)
  of ColorOption.FourGray:
    self.renderFourGray(image)
  of ColorOption.BlackWhiteYellowRed:
    self.renderBlackWhiteYellowRed(image)

  waveshareDriver.sleep()

# Convert the rendered pixels to a PNG image. For accurate colors on the web.
proc toPng*(rotate: int = 0): string =
  var outputImage = newImage(width, height)
  case waveshareDriver.colorOption:
  of ColorOption.Black:
    let pixels = getLastFloatImage()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixel = (pixels[index] * 255).uint8
        outputImage.data[index].r = pixel
        outputImage.data[index].g = pixel
        outputImage.data[index].b = pixel
        outputImage.data[index].a = 255
  of ColorOption.FourGray:
    let pixels = getLastFloatImage()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixel = (pixels[index] * 85).uint8
        outputImage.data[index].r = pixel
        outputImage.data[index].g = pixel
        outputImage.data[index].b = pixel
        outputImage.data[index].a = 255
  of ColorOption.BlackWhiteRed:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixelIndex = index div 4
        let pixelShift = (3 - (index mod 4)) * 2
        let pixel = (pixels[pixelIndex] shr pixelShift) and 0x03
        outputImage.data[index].r = if pixel == 0: 0 else: 255
        outputImage.data[index].g = if pixel == 2: 255 else: 1
        outputImage.data[index].b = if pixel == 2: 255 else: 1
        outputImage.data[index].a = 255
  of ColorOption.BlackWhiteYellowRed:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixelIndex = index div 4
        let pixelShift = (3 - (index mod 4)) * 2
        let pixel = (pixels[pixelIndex] shr pixelShift) and 0x03
        outputImage.data[index].r = saturated4ColorPalette[pixel][0].uint8
        outputImage.data[index].g = saturated4ColorPalette[pixel][1].uint8
        outputImage.data[index].b = saturated4ColorPalette[pixel][2].uint8
        outputImage.data[index].a = 255
  of ColorOption.SevenColor:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixelIndex = index div 2
        let pixelShift = (1 - (index mod 2)) * 4
        let pixel = (pixels[pixelIndex] shr pixelShift) and 0x07
        outputImage.data[index].r = saturated7ColorPalette[pixel][0].uint8
        outputImage.data[index].g = saturated7ColorPalette[pixel][1].uint8
        outputImage.data[index].b = saturated7ColorPalette[pixel][2].uint8
        outputImage.data[index].a = 255

  if rotate != 0:
    return outputImage.rotateDegrees(rotate).encodeImage(PngFormat)

  return outputImage.encodeImage(PngFormat)

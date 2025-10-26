import pixie, json, times, locks, options

import frameos/types
import frameos/utils/image
import frameos/utils/dither
import drivers/waveshare/driver as waveshareDriver
from drivers/waveshare/types import Driver, ColorOption, setDriverDebugLogger
export Driver

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

  setDriverDebugLogger(logger)
  logger.log(%*{"event": "driver:waveshare", "width": width, "height": height, "init": "starting"})
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
      palette: none(seq[(int, int, int)]),
      vcom: frameOS.frameConfig.deviceConfig.vcom
    )

    if waveshareDriver.colorOption == ColorOption.SpectraSixColor and len(frameOS.frameConfig.palette.colors) == 6:
      let c = frameOS.frameConfig.palette.colors
      result.palette = some(@[
        (c[0][0], c[0][1], c[0][2]),
        (c[1][0], c[1][1], c[1][2]),
        (c[2][0], c[2][1], c[2][2]),
        (c[3][0], c[3][1], c[3][2]),
        (999, 999, 999),
        (c[4][0], c[4][1], c[4][2]),
        (c[5][0], c[5][1], c[5][2]),
      ])
    else:
      result.palette = some(spectra6ColorPalette)

  except Exception as e:
    logger.log(%*{"event": "driver:waveshare",
        "error": "Failed to initialize driver", "exception": e.msg,
        "stack": e.getStackTrace()})

proc notifyImageAvailable*(self: Driver) =
  self.logger.log(%*{"event": "render:dither", "info": "Dithered image available, starting render"})

proc renderBlack*(self: Driver, image: Image) =
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray)
  gray.floydSteinberg(image.width, image.height)

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

proc renderSixteenGray*(self: Driver, image: Image) =
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray, 15)
  gray.floydSteinberg(image.width, image.height)
  setLastFloatImage(gray)
  self.notifyImageAvailable()

  let rowWidth = ceil(image.width.float / 2).int
  var blackImage = newSeq[uint8](rowWidth * image.height)

  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let i = y * image.width + x
      let nibble = (gray[inputIndex].uint8 and 0x0F)
      let shift = if (i mod 2) == 0: 4 else: 0
      blackImage[i div 2] = blackImage[i div 2] or (nibble shl shift)
  waveshareDriver.renderImage(blackImage)

proc renderBlackWhiteRed*(self: Driver, image: Image, isRed = true) =
  let pixels = ditherPaletteIndexed(image, @[(0, 0, 0), (255, if isRed: 0 else: 255, 0), (255, 255, 255)])
  let inputRowWidth = int(ceil(image.width.float / 4))
  let packedRowWidth = int(ceil(image.width.float / 8))
  var blackImage = newSeq[uint8](packedRowWidth * image.height)
  var redImage = newSeq[uint8](packedRowWidth * image.height)

  setLastPixels(pixels)
  self.notifyImageAvailable()

  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * inputRowWidth + x div 4
      let pixelByte = pixels[inputIndex]
      let pixelValue = (pixelByte shr ((3 - x mod 4) * 2)) and 0b11

      let black: uint8 = if pixelValue == 0: 0'u8 else: 1'u8
      let red: uint8 = if pixelValue == 1: 0'u8 else: 1'u8

      let outputIndex = y * packedRowWidth + x div 8

      blackImage[outputIndex] = blackImage[outputIndex] or (black shl (7 - x mod 8))
      redImage[outputIndex] = redImage[outputIndex] or (red shl (7 - x mod 8))

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

proc renderSpectraSixColor*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, if self.palette.isSome(): self.palette.get() else: spectra6ColorPalette)
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
  self.logger.log(%*{"event": "driver:waveshare", "render": "starting", "color": waveshareDriver.colorOption})
  waveshareDriver.start(self)

  case waveshareDriver.colorOption:
  of ColorOption.Black:
    self.renderBlack(image)
  of ColorOption.BlackWhiteRed:
    self.renderBlackWhiteRed(image, true)
  of ColorOption.BlackWhiteYellow:
    self.renderBlackWhiteRed(image, false)
  of ColorOption.SevenColor:
    self.renderSevenColor(image)
  of ColorOption.SpectraSixColor:
    self.renderSpectraSixColor(image)
  of ColorOption.FourGray:
    self.renderFourGray(image)
  of ColorOption.SixteenGray:
    self.renderSixteenGray(image)
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
  of ColorOption.SixteenGray:
    let pixels = getLastFloatImage()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixel = (pixels[index] * 17).uint8
        outputImage.data[index].r = pixel
        outputImage.data[index].g = pixel
        outputImage.data[index].b = pixel
        outputImage.data[index].a = 255
  of ColorOption.BlackWhiteRed, ColorOption.BlackWhiteYellow:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    let inputRowWidth = int(ceil(width.float / 4))
    for y in 0 ..< height:
      for x in 0 ..< width:
        let inputIndex = y * inputRowWidth + x div 4
        let pixelByte = pixels[inputIndex]
        let pixelShift = (3 - (x mod 4)) * 2
        let pixel = (pixelByte shr pixelShift) and 0x03
        let index = y * width + x
        outputImage.data[index].r = if pixel == 0: 0 else: 255
        outputImage.data[index].g = if pixel == 2: 255
                                    elif pixel == 1 and waveshareDriver.colorOption == ColorOption.BlackWhiteYellow: 255
                                    else: 0
        outputImage.data[index].b = if pixel == 2: 255 else: 0
        outputImage.data[index].a = 255
  of ColorOption.BlackWhiteYellowRed:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    let inputRowWidth = int(ceil(width.float / 4))
    for y in 0 ..< height:
      for x in 0 ..< width:
        let inputIndex = y * inputRowWidth + x div 4
        let pixelByte = pixels[inputIndex]
        let pixelShift = (3 - (x mod 4)) * 2
        let pixel = (pixelByte shr pixelShift) and 0x03
        let index = y * width + x

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
  of ColorOption.SpectraSixColor:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    for y in 0 ..< height:
      for x in 0 ..< width:
        let index = y * width + x
        let pixelIndex = index div 2
        let pixelShift = (1 - (index mod 2)) * 4
        let pixel = (pixels[pixelIndex] shr pixelShift) and 0x07
        outputImage.data[index].r = spectra6ColorPalette[pixel][0].uint8
        outputImage.data[index].g = spectra6ColorPalette[pixel][1].uint8
        outputImage.data[index].b = spectra6ColorPalette[pixel][2].uint8
        outputImage.data[index].a = 255

  if rotate != 0:
    return outputImage.rotateDegrees(rotate).encodeImage(PngFormat)

  return outputImage.encodeImage(PngFormat)

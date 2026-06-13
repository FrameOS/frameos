import pixie, json, times, options, math, hashes

import frameos/driver_context
import frameos/device_setup
import frameos/utils/dither
import drivers/waveshare/driver as waveshareDriver
import drivers/waveshare/preview
from drivers/waveshare/types import Driver, ColorOption, setDriverDebugLogger
export Driver
export preview

proc hashImageData(data: seq[ColorRGBX]): Hash =
  var h = hash(data.len)
  for pixel in data:
    h = h !& hash(pixel.r)
    h = h !& hash(pixel.g)
    h = h !& hash(pixel.b)
    h = h !& hash(pixel.a)
  !$h

proc logGrayBuffer(self: Driver, mode: string, pixelCount: int, grayBytes: int, previewBytes: int, packedBytes: int) =
  self.logger.log(%*{
    "event": "driver:waveshare:buffer",
    "mode": mode,
    "pixels": pixelCount,
    "grayBytes": grayBytes,
    "previewBytes": previewBytes,
    "packedBytes": packedBytes,
  })

proc setup*(frameOS: DriverContext = nil): SetupResult =
  waveshareDriver.setup(frameOS)

proc init*(frameOS: DriverContext): Driver =
  let logger = frameOS.logger
  let width = waveshareDriver.width
  let height = waveshareDriver.height

  setDriverDebugLogger(logger)
  logger.log(%*{"event": "driver:waveshare", "width": width, "height": height, "init": "starting"})
  if not frameOS.frameConfig.deviceConfig.isNil and
      not frameOS.frameConfig.deviceConfig.pins.isNil:
    waveshareDriver.setPinOverrides(frameOS.frameConfig.deviceConfig.pins)
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
  let levels = grayToLevels(gray, 1)

  setLastGrayImage(levels, 1)
  self.notifyImageAvailable()

  let rowWidth = ceil(image.width.float / 8).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 8 + x
      let bw: uint8 = levels[inputIndex] and 0x01
      blackImage[index div 8] = blackImage[index div 8] or (bw shl (7 - (index mod 8)))
  self.logGrayBuffer("Black", image.width * image.height, gray.len * sizeof(float), levels.len, blackImage.len)
  waveshareDriver.renderImage(blackImage)

proc renderFourGray*(self: Driver, image: Image) =
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray, 3)
  gray.floydSteinberg(image.width, image.height)
  let levels = grayToLevels(gray, 3)
  setLastGrayImage(levels, 3)
  self.notifyImageAvailable()

  let rowWidth = ceil(image.width.float / 4).int
  var blackImage = newSeq[uint8](rowWidth * image.height)
  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let index = y * rowWidth * 4 + x
      let bw: uint8 = levels[inputIndex] and 0b11 # 0, 1, 2 or 3
      blackImage[index div 4] = blackImage[index div 4] or ((bw and 0b11) shl (6 - (index mod 4) * 2))
  self.logGrayBuffer("FourGray", image.width * image.height, gray.len * sizeof(float), levels.len, blackImage.len)
  waveshareDriver.renderImage(blackImage)

proc renderSixteenGray*(self: Driver, image: Image) =
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray, 15)
  gray.floydSteinberg(image.width, image.height)
  let levels = grayToLevels(gray, 15)
  setLastGrayImage(levels, 15)
  self.notifyImageAvailable()

  let rowWidth = ceil(image.width.float / 2).int
  var blackImage = newSeq[uint8](rowWidth * image.height)

  for y in 0..<image.height:
    for x in 0..<image.width:
      let inputIndex = y * image.width + x
      let i = y * image.width + x
      let nibble = levels[inputIndex] and 0x0F
      let shift = if (i mod 2) == 0: 4 else: 0
      blackImage[i div 2] = blackImage[i div 2] or (nibble shl shift)
  self.logGrayBuffer("SixteenGray", image.width * image.height, gray.len * sizeof(float), levels.len, blackImage.len)
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
  let currentImageHash = hashImageData(image.data)
  if self.lastImageBytes == image.data.len and self.lastImageHash == currentImageHash and
      self.lastRenderAt > epochTime() - 12 * 60 * 60:
    self.logger.log(%*{"event": "driver:waveshare",
        "info": "Skipping render, image data is the same"})
    return

  self.lastImageBytes = image.data.len
  self.lastImageHash = currentImageHash
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
proc toPng*(rotate: int = 0, flip: string = ""): string =
  toCachedPreviewPng(waveshareDriver.colorOption, waveshareDriver.width, waveshareDriver.height, rotate, flip)

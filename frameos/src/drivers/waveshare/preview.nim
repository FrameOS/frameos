import locks, math, options
import pixie/fileformats/png

import frameos/utils/image
import frameos/utils/dither
from drivers/waveshare/color import ColorOption

var
  lastGrayImageLock: Lock
  lastGrayImage: seq[uint8] = @[]
  lastGrayImageMax: uint8 = 0
  lastPixelsLock: Lock
  lastPixels: seq[uint8] = @[]
  lastPreviewLock: Lock
  lastPreviewVersion: int = 0
  cachedPreviewVersion: int = -1
  cachedPreviewRotate: int = 0
  cachedPreviewFlip: string = ""
  cachedPreviewColor: string = ""
  cachedPreviewPng: string = ""

proc notePreviewChanged() =
  withLock lastPreviewLock:
    inc lastPreviewVersion
    cachedPreviewPng = ""

proc setLastGrayImage*(image: seq[uint8], maxValue: uint8) =
  withLock lastGrayImageLock:
    lastGrayImage = image
    lastGrayImageMax = maxValue
  notePreviewChanged()

proc getLastGrayImage*(): tuple[pixels: seq[uint8], maxValue: uint8] =
  withLock lastGrayImageLock:
    result = (lastGrayImage, lastGrayImageMax)

proc setLastPixels*(image: seq[uint8]) =
  withLock lastPixelsLock:
    lastPixels = image
  notePreviewChanged()

proc getLastPixels*(): seq[uint8] =
  withLock lastPixelsLock:
    result = lastPixels

proc currentPreviewVersion(): int =
  withLock lastPreviewLock:
    result = lastPreviewVersion

proc getCachedPreview(version, rotate: int, flip, color: string): Option[string] =
  withLock lastPreviewLock:
    if cachedPreviewVersion == version and cachedPreviewRotate == rotate and
        cachedPreviewFlip == flip and cachedPreviewColor == color and cachedPreviewPng.len > 0:
      return some(cachedPreviewPng)
  none(string)

proc setCachedPreview(version, rotate: int, flip, color, png: string) =
  withLock lastPreviewLock:
    if lastPreviewVersion == version:
      cachedPreviewVersion = version
      cachedPreviewRotate = rotate
      cachedPreviewFlip = flip
      cachedPreviewColor = color
      cachedPreviewPng = png

proc resetPreviewCacheForTest*() =
  withLock lastPreviewLock:
    lastPreviewVersion = 0
    cachedPreviewVersion = -1
    cachedPreviewRotate = 0
    cachedPreviewFlip = ""
    cachedPreviewColor = ""
    cachedPreviewPng = ""

proc grayLevel*(value: float, maxValue: uint8): uint8 {.inline.} =
  let rounded = round(value).int
  if rounded < 0:
    return 0
  if rounded > maxValue.int:
    return maxValue
  rounded.uint8

proc grayToLevels*(gray: seq[float], maxValue: uint8): seq[uint8] =
  result = newSeq[uint8](gray.len)
  for index in 0 ..< gray.len:
    result[index] = grayLevel(gray[index], maxValue)

proc previewGrayByte(value, maxValue: uint8): uint8 {.inline.} =
  if maxValue == 0:
    return 0
  ((min(value.int, maxValue.int) * 255) div maxValue.int).uint8

proc encodeGrayPreviewPng*(
    pixels: seq[uint8],
    maxValue: uint8,
    sourceWidth, sourceHeight, rotate: int,
    flip: string
  ): string =
  if pixels.len < sourceWidth * sourceHeight:
    raise newException(Exception, "No render yet")

  let dimensions = previewDimensions(sourceWidth, sourceHeight, rotate)
  var preview = newSeq[uint8](dimensions.width * dimensions.height)
  for y in 0 ..< dimensions.height:
    for x in 0 ..< dimensions.width:
      let sourceIndex = previewSourceIndex(x, y, sourceWidth, sourceHeight, rotate, flip)
      preview[y * dimensions.width + x] = previewGrayByte(pixels[sourceIndex], maxValue)

  encodePng(dimensions.width, dimensions.height, 1, preview[0].addr, preview.len)

proc setRgb(preview: var seq[uint8], index: int, r, g, b: int) {.inline.} =
  let offset = index * 3
  preview[offset] = r.uint8
  preview[offset + 1] = g.uint8
  preview[offset + 2] = b.uint8

proc encodePackedTwoBitPreviewPng*(
    pixels: seq[uint8],
    sourceWidth, sourceHeight, rotate: int,
    flip: string,
    yellow: bool
  ): string =
  let inputRowWidth = int(ceil(sourceWidth.float / 4))
  if pixels.len < inputRowWidth * sourceHeight:
    raise newException(Exception, "No render yet")

  let dimensions = previewDimensions(sourceWidth, sourceHeight, rotate)
  var preview = newSeq[uint8](dimensions.width * dimensions.height * 3)
  for y in 0 ..< dimensions.height:
    for x in 0 ..< dimensions.width:
      let sourceIndex = previewSourceIndex(x, y, sourceWidth, sourceHeight, rotate, flip)
      let sourceX = sourceIndex mod sourceWidth
      let sourceY = sourceIndex div sourceWidth
      let inputIndex = sourceY * inputRowWidth + sourceX div 4
      let pixelByte = pixels[inputIndex]
      let pixelShift = (3 - (sourceX mod 4)) * 2
      let pixel = (pixelByte shr pixelShift) and 0x03
      let outputIndex = y * dimensions.width + x
      setRgb(preview, outputIndex,
        if pixel == 0: 0 else: 255,
        if pixel == 2 or (pixel == 1 and yellow): 255 else: 0,
        if pixel == 2: 255 else: 0)

  encodePng(dimensions.width, dimensions.height, 3, preview[0].addr, preview.len)

proc encodePalettePreviewPng*(
    pixels: seq[uint8],
    sourceWidth, sourceHeight, rotate: int,
    flip: string,
    palette: seq[(int, int, int)]
  ): string =
  let packedWidth = int(ceil(sourceWidth.float / 2))
  if pixels.len < packedWidth * sourceHeight:
    raise newException(Exception, "No render yet")

  let dimensions = previewDimensions(sourceWidth, sourceHeight, rotate)
  var preview = newSeq[uint8](dimensions.width * dimensions.height * 3)
  for y in 0 ..< dimensions.height:
    for x in 0 ..< dimensions.width:
      let sourceIndex = previewSourceIndex(x, y, sourceWidth, sourceHeight, rotate, flip)
      let pixelIndex = sourceIndex div 2
      let pixelShift = (1 - (sourceIndex mod 2)) * 4
      let pixel = (pixels[pixelIndex] shr pixelShift) and 0x07
      let outputIndex = y * dimensions.width + x
      setRgb(preview, outputIndex, palette[pixel][0], palette[pixel][1], palette[pixel][2])

  encodePng(dimensions.width, dimensions.height, 3, preview[0].addr, preview.len)

proc toCachedPreviewPng*(colorOption: ColorOption, sourceWidth, sourceHeight, rotate: int, flip: string): string =
  let
    color = $colorOption
    version = currentPreviewVersion()
    cached = getCachedPreview(version, rotate, flip, color)
  if cached.isSome:
    return cached.get()

  var png: string
  case colorOption:
  of ColorOption.Black:
    let (pixels, _) = getLastGrayImage()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    png = encodeGrayPreviewPng(pixels, 1, sourceWidth, sourceHeight, rotate, flip)
  of ColorOption.FourGray:
    let (pixels, maxValue) = getLastGrayImage()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    png = encodeGrayPreviewPng(pixels, maxValue, sourceWidth, sourceHeight, rotate, flip)
  of ColorOption.SixteenGray:
    let (pixels, maxValue) = getLastGrayImage()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    png = encodeGrayPreviewPng(pixels, maxValue, sourceWidth, sourceHeight, rotate, flip)
  of ColorOption.BlackWhiteRed, ColorOption.BlackWhiteYellow:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    png = encodePackedTwoBitPreviewPng(pixels, sourceWidth, sourceHeight, rotate, flip,
      colorOption == ColorOption.BlackWhiteYellow)
  of ColorOption.BlackWhiteYellowRed:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    let inputRowWidth = int(ceil(sourceWidth.float / 4))
    if pixels.len < inputRowWidth * sourceHeight:
      raise newException(Exception, "No render yet")
    let dimensions = previewDimensions(sourceWidth, sourceHeight, rotate)
    var preview = newSeq[uint8](dimensions.width * dimensions.height * 3)
    for y in 0 ..< dimensions.height:
      for x in 0 ..< dimensions.width:
        let sourceIndex = previewSourceIndex(x, y, sourceWidth, sourceHeight, rotate, flip)
        let sourceX = sourceIndex mod sourceWidth
        let sourceY = sourceIndex div sourceWidth
        let inputIndex = sourceY * inputRowWidth + sourceX div 4
        let pixelByte = pixels[inputIndex]
        let pixelShift = (3 - (sourceX mod 4)) * 2
        let pixel = (pixelByte shr pixelShift) and 0x03
        let outputIndex = y * dimensions.width + x
        setRgb(preview, outputIndex, saturated4ColorPalette[pixel][0], saturated4ColorPalette[pixel][1],
          saturated4ColorPalette[pixel][2])
    png = encodePng(dimensions.width, dimensions.height, 3, preview[0].addr, preview.len)
  of ColorOption.SevenColor:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    png = encodePalettePreviewPng(pixels, sourceWidth, sourceHeight, rotate, flip, saturated7ColorPalette)
  of ColorOption.SpectraSixColor:
    let pixels = getLastPixels()
    if pixels.len == 0:
      raise newException(Exception, "No render yet")
    png = encodePalettePreviewPng(pixels, sourceWidth, sourceHeight, rotate, flip, spectra6ColorPalette)

  setCachedPreview(version, rotate, flip, color, png)
  png

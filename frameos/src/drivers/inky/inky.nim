import pixie, json, times, options, hashes

import frameos/driver_context
import frameos/device_setup
import frameos/utils/dither
import frameos/utils/image
import drivers/inky/panels
import drivers/spi/spi as spiSetupDriver
import drivers/waveshare/preview
from drivers/waveshare/types import ColorOption, setDriverDebugLogger
export preview

const bootConfigLines = @["dtoverlay=spi0-0cs"]

type Driver* = ref object of FrameOSDriver
  logger*: DriverLogger
  panel*: PanelSpec
  ready*: bool
  lastImageHash*: Hash
  lastImageBytes*: int
  lastRenderAt*: float
  palette*: Option[seq[(int, int, int)]]

var
  lastPreviewColor = ColorOption.SpectraSixColor
  lastPreviewWidth = 0
  lastPreviewHeight = 0

proc hashImageData(data: seq[ColorRGBX]): Hash =
  var h = hash(data.len)
  for pixel in data:
    h = h !& hash(pixel.r)
    h = h !& hash(pixel.g)
    h = h !& hash(pixel.b)
    h = h !& hash(pixel.a)
  !$h

proc setup*(frameOS: DriverContext = nil): SetupResult =
  discard frameOS
  addSetupResult(result, runSetupStep("spi", proc(): SetupResult = spiSetupDriver.setup()))
  addSetupResult(result, runSetupStep("bootConfig", proc(): SetupResult = setupBootConfig(bootConfigLines)))

proc init*(frameOS: DriverContext): Driver =
  let
    logger = frameOS.logger
    panel = panelForDevice(frameOS.frameConfig.device)

  setDriverDebugLogger(logger)
  logger.log(%*{
    "event": "driver:inky",
    "device": frameOS.frameConfig.device,
    "width": panel.width,
    "height": panel.height,
    "color": $panel.colorOption,
    "init": "starting",
  })

  frameOS.frameConfig.width = panel.width
  frameOS.frameConfig.height = panel.height
  lastPreviewColor = panel.colorOption
  lastPreviewWidth = panel.width
  lastPreviewHeight = panel.height

  result = Driver(
    name: "inky",
    logger: logger,
    panel: panel,
    ready: false,
    palette: none(seq[(int, int, int)]),
  )

  if panel.colorOption == ColorOption.SpectraSixColor and len(frameOS.frameConfig.palette.colors) == 6:
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
  elif panel.colorOption == ColorOption.SpectraSixColor:
    result.palette = some(spectra6ColorPalette)

  try:
    initHardware(panel)
    result.ready = true
    logger.log(%*{"event": "driver:inky", "device": frameOS.frameConfig.device, "init": "complete"})
  except Exception as e:
    logger.log(%*{
      "event": "driver:inky",
      "device": frameOS.frameConfig.device,
      "error": "Failed to initialize native Inky driver",
      "exception": e.msg,
      "stack": e.getStackTrace(),
    })

proc notifyImageAvailable*(self: Driver) =
  self.logger.log(%*{"event": "render:dither", "info": "Dithered image available, starting render"})

proc imageForPanel(self: Driver, image: Image): Image =
  if image.width == self.panel.width and image.height == self.panel.height:
    return image

  self.logger.log(%*{
    "event": "driver:inky",
    "warning": "Image dimensions differ from panel dimensions; resizing before render",
    "imageWidth": image.width,
    "imageHeight": image.height,
    "panelWidth": self.panel.width,
    "panelHeight": self.panel.height,
  })
  result = newImage(self.panel.width, self.panel.height)
  result.fill(parseHtmlColor("#ffffff"))
  result.scaleAndDrawImage(image, "contain")

proc renderSevenColor*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, saturated7ColorPalette)
  setLastPixels(pixels)
  self.notifyImageAvailable()
  renderPacked(self.panel, pixels)

proc renderSpectraSixColor*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, if self.palette.isSome(): self.palette.get() else: spectra6ColorPalette)
  setLastPixels(pixels)
  self.notifyImageAvailable()
  renderPacked(self.panel, pixels)

proc renderFourColor*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, saturated4ColorPalette)
  setLastPixels(pixels)
  self.notifyImageAvailable()
  renderPacked(self.panel, pixels)

proc renderBlack*(self: Driver, image: Image) =
  var gray = newSeq[float](image.width * image.height)
  image.toGrayscaleFloat(gray)
  gray.floydSteinberg(image.width, image.height)
  let levels = grayToLevels(gray, 1)
  setLastGrayImage(levels, 1)
  self.notifyImageAvailable()

  let rowWidth = (image.width + 7) div 8
  var pixels = newSeq[uint8](rowWidth * image.height)
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let
        inputIndex = y * image.width + x
        outputIndex = y * rowWidth + x div 8
        shift = 7 - (x mod 8)
      pixels[outputIndex] = pixels[outputIndex] or ((levels[inputIndex] and 0x01'u8) shl shift)

  renderPacked(self.panel, pixels)

proc renderBlackWhiteRed*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, @[(0, 0, 0), (255, 0, 0), (255, 255, 255)])
  setLastPixels(pixels)
  self.notifyImageAvailable()
  renderPacked(self.panel, pixels)

proc renderBlackWhiteYellow*(self: Driver, image: Image) =
  let pixels = ditherPaletteIndexed(image, @[(0, 0, 0), (255, 255, 0), (255, 255, 255)])
  setLastPixels(pixels)
  self.notifyImageAvailable()
  renderPacked(self.panel, pixels)

proc render*(self: Driver, image: Image) =
  if not self.ready:
    try:
      initHardware(self.panel)
      self.ready = true
    except Exception as e:
      self.logger.log(%*{"event": "driver:inky", "error": "Render skipped; driver is not initialized", "exception": e.msg})
      return

  let panelImage = self.imageForPanel(image)
  let currentImageHash = hashImageData(panelImage.data)
  if self.lastImageBytes == panelImage.data.len and self.lastImageHash == currentImageHash and
      self.lastRenderAt > epochTime() - 12 * 60 * 60:
    self.logger.log(%*{"event": "driver:inky", "info": "Skipping render, image data is the same"})
    return

  self.lastImageBytes = panelImage.data.len
  self.lastImageHash = currentImageHash
  self.lastRenderAt = epochTime()
  lastPreviewColor = self.panel.colorOption
  lastPreviewWidth = self.panel.width
  lastPreviewHeight = self.panel.height

  self.logger.log(%*{
    "event": "driver:inky",
    "render": "starting",
    "device": self.panel.device,
    "color": $self.panel.colorOption,
  })

  try:
    start(self.panel)
    case self.panel.colorOption
    of ColorOption.Black:
      self.renderBlack(panelImage)
    of ColorOption.SevenColor:
      self.renderSevenColor(panelImage)
    of ColorOption.SpectraSixColor:
      self.renderSpectraSixColor(panelImage)
    of ColorOption.BlackWhiteRed:
      self.renderBlackWhiteRed(panelImage)
    of ColorOption.BlackWhiteYellow:
      self.renderBlackWhiteYellow(panelImage)
    of ColorOption.BlackWhiteYellowRed:
      self.renderFourColor(panelImage)
    else:
      raise newException(ValueError, "Unsupported native Inky color option: " & $self.panel.colorOption)
    sleep(self.panel)
    self.logger.log(%*{"event": "driver:inky", "render": "complete", "device": self.panel.device})
  except Exception as e:
    self.logger.log(%*{
      "event": "driver:inky",
      "device": self.panel.device,
      "error": "Native Inky render failed",
      "exception": e.msg,
      "stack": e.getStackTrace(),
    })

proc toPng*(rotate: int = 0, flip: string = ""): string =
  toCachedPreviewPng(lastPreviewColor, lastPreviewWidth, lastPreviewHeight, rotate, flip)

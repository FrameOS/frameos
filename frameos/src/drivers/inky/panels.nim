import json

import drivers/inky/hal
from drivers/waveshare/color import ColorOption
from drivers/waveshare/types import logDriverDebug, driverDebugLogsEnabled

type
  PanelKind* = enum
    InkyImpression7Color,
    InkyImpression57Uc8159,
    InkyImpression4Uc8159,
    InkyImpression4Spectra6,
    InkyImpression73Spectra6,
    InkyImpression133Spectra6,
    InkyPhatLegacy,
    InkyPhatSsd1608,
    InkyPhatJd79661,
    InkyWhatJd79668,
    InkyWhatLegacy,
    InkyWhatSsd1683

  PanelAccent* = enum
    AccentNone,
    AccentBlack,
    AccentRed,
    AccentRedHighTemp,
    AccentYellow

  PanelSpec* = object
    kind*: PanelKind
    device*: string
    width*: int
    height*: int
    colorOption*: ColorOption
    accent*: PanelAccent

const
  Ac073Cmdh = 0xAA'u8
  Ac073Psr = 0x00'u8
  Ac073Pwr = 0x01'u8
  Ac073Pof = 0x02'u8
  Ac073Pofs = 0x03'u8
  Ac073Pon = 0x04'u8
  Ac073Btst1 = 0x05'u8
  Ac073Btst2 = 0x06'u8
  Ac073Btst3 = 0x08'u8
  Ac073Dtm = 0x10'u8
  Ac073Drf = 0x12'u8
  Ac073Ipc = 0x13'u8
  Ac073Pll = 0x30'u8
  Ac073Tse = 0x41'u8
  Ac073Cdi = 0x50'u8
  Ac073Tcon = 0x60'u8
  Ac073Tres = 0x61'u8
  Ac073Vdcs = 0x82'u8
  Ac073TVdcs = 0x84'u8
  Ac073Agid = 0x86'u8
  Ac073Ccset = 0xE0'u8
  Ac073Pws = 0xE3'u8
  Ac073Tsset = 0xE6'u8

  Uc8159Psr = 0x00'u8
  Uc8159Pwr = 0x01'u8
  Uc8159Pof = 0x02'u8
  Uc8159Pfs = 0x03'u8
  Uc8159Pon = 0x04'u8
  Uc8159Dtm1 = 0x10'u8
  Uc8159Drf = 0x12'u8
  Uc8159Pll = 0x30'u8
  Uc8159Tse = 0x41'u8
  Uc8159Cdi = 0x50'u8
  Uc8159Tcon = 0x60'u8
  Uc8159Tres = 0x61'u8
  Uc8159Dam = 0x65'u8
  Uc8159Pws = 0xE3'u8

  SpectraPsr = 0x00'u8
  SpectraPwr = 0x01'u8
  SpectraPof = 0x02'u8
  SpectraPofs = 0x03'u8
  SpectraPon = 0x04'u8
  SpectraBtst1 = 0x05'u8
  SpectraBtst2 = 0x06'u8
  SpectraBtst3 = 0x08'u8
  SpectraDtm1 = 0x10'u8
  SpectraDrf = 0x12'u8
  SpectraPll = 0x30'u8
  SpectraCdi = 0x50'u8
  SpectraTcon = 0x60'u8
  SpectraTres = 0x61'u8
  SpectraVdcs = 0x82'u8
  SpectraPws = 0xE3'u8

  El133Psr = 0x00'u8
  El133Pwr = 0x01'u8
  El133Pof = 0x02'u8
  El133Pofs = 0x03'u8
  El133Pon = 0x04'u8
  El133BtstN = 0x05'u8
  El133BtstP = 0x06'u8
  El133Dtm = 0x10'u8
  El133Drf = 0x12'u8
  El133Pll = 0x30'u8
  El133Cdi = 0x50'u8
  El133Tcon = 0x60'u8
  El133Tres = 0x61'u8
  El133Antm = 0x74'u8
  El133Agid = 0x86'u8
  El133CmdA4 = 0xA4'u8
  El133Dcdc = 0xA5'u8
  El133BuckBoostVddn = 0xB0'u8
  El133TftVcomPower = 0xB1'u8
  El133EnBuf = 0xB6'u8
  El133BoostVddpEn = 0xB7'u8
  El133Ccset = 0xE0'u8
  El133Pws = 0xE3'u8
  El133Cmd66 = 0xF0'u8

  JdPsr = 0x00'u8
  JdPwr = 0x01'u8
  JdPof = 0x02'u8
  JdPofs = 0x03'u8
  JdPon = 0x04'u8
  JdBtstP = 0x06'u8
  JdDslp = 0x07'u8
  JdDtm = 0x10'u8
  JdDrf = 0x12'u8
  JdCdi = 0x50'u8
  JdTcon = 0x60'u8
  JdTres = 0x61'u8
  JdPws = 0xE3'u8

  SsdDriverControl = 0x01'u8
  SsdGateVoltage = 0x03'u8
  SsdSourceVoltage = 0x04'u8
  SsdDeepSleep = 0x10'u8
  SsdDataMode = 0x11'u8
  SsdSwReset = 0x12'u8
  SsdMasterActivate = 0x20'u8
  SsdWriteRam = 0x24'u8
  SsdWriteAltRam = 0x26'u8
  SsdWriteVcom = 0x2C'u8
  SsdWriteLut = 0x32'u8
  SsdWriteDummy = 0x3A'u8
  SsdWriteGateline = 0x3B'u8
  SsdWriteBorder = 0x3C'u8
  SsdSetRamXPos = 0x44'u8
  SsdSetRamYPos = 0x45'u8
  SsdSetRamXCount = 0x4E'u8
  SsdSetRamYCount = 0x4F'u8

const LegacyBlackLut: array[70, uint8] = [
  0b01001000'u8, 0b10100000, 0b00010000, 0b00010000, 0b00010011, 0b00000000, 0b00000000,
  0b01001000'u8, 0b10100000, 0b10000000, 0b00000000, 0b00000011, 0b00000000, 0b00000000,
  0b00000000'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0b01001000'u8, 0b10100101, 0b00000000, 0b10111011, 0b00000000, 0b00000000, 0b00000000,
  0b00000000'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0x10'u8, 0x04, 0x04, 0x04, 0x04,
  0x10'u8, 0x04, 0x04, 0x04, 0x04,
  0x04'u8, 0x08, 0x08, 0x10, 0x10,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
]

const LegacyRedLut: array[70, uint8] = [
  0b01001000'u8, 0b10100000, 0b00010000, 0b00010000, 0b00010011, 0b00000000, 0b00000000,
  0b01001000'u8, 0b10100000, 0b10000000, 0b00000000, 0b00000011, 0b00000000, 0b00000000,
  0b00000000'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0b01001000'u8, 0b10100101, 0b00000000, 0b10111011, 0b00000000, 0b00000000, 0b00000000,
  0b00000000'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0x40'u8, 0x0C, 0x20, 0x0C, 0x06,
  0x10'u8, 0x08, 0x04, 0x04, 0x06,
  0x04'u8, 0x08, 0x08, 0x10, 0x10,
  0x02'u8, 0x02, 0x02, 0x40, 0x20,
  0x02'u8, 0x02, 0x02, 0x02, 0x02,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
]

const LegacyRedHighTempLut: array[70, uint8] = [
  0b01001000'u8, 0b10100000, 0b00010000, 0b00010000, 0b00010011, 0b00010000, 0b00010000,
  0b01001000'u8, 0b10100000, 0b10000000, 0b00000000, 0b00000011, 0b10000000, 0b10000000,
  0b00000000'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0b01001000'u8, 0b10100101, 0b00000000, 0b10111011, 0b00000000, 0b01001000, 0b00000000,
  0b00000000'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0x43'u8, 0x0A, 0x1F, 0x0A, 0x04,
  0x10'u8, 0x08, 0x04, 0x04, 0x06,
  0x04'u8, 0x08, 0x08, 0x10, 0x0B,
  0x02'u8, 0x04, 0x04, 0x40, 0x10,
  0x06'u8, 0x06, 0x06, 0x02, 0x02,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
]

const LegacyYellowLut: array[70, uint8] = [
  0b11111010'u8, 0b10010100, 0b10001100, 0b11000000, 0b11010000, 0b00000000, 0b00000000,
  0b11111010'u8, 0b10010100, 0b00101100, 0b10000000, 0b11100000, 0b00000000, 0b00000000,
  0b11111010'u8, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
  0b11111010'u8, 0b10010100, 0b11111000, 0b10000000, 0b01010000, 0b00000000, 0b11001100,
  0b10111111'u8, 0b01011000, 0b11111100, 0b10000000, 0b11010000, 0b00000000, 0b00010001,
  0x40'u8, 0x10, 0x40, 0x10, 0x08,
  0x08'u8, 0x10, 0x04, 0x04, 0x10,
  0x08'u8, 0x08, 0x03, 0x08, 0x20,
  0x08'u8, 0x04, 0x00, 0x00, 0x10,
  0x10'u8, 0x08, 0x08, 0x00, 0x20,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
  0x00'u8, 0x00, 0x00, 0x00, 0x00,
]

const Ssd1608Lut: array[30, uint8] = [
  0x02'u8, 0x02, 0x01, 0x11, 0x12, 0x12, 0x22, 0x22, 0x66, 0x69,
  0x69'u8, 0x59, 0x58, 0x99, 0x99, 0x88, 0x00, 0x00, 0x00, 0x00,
  0xF8'u8, 0xB4, 0x13, 0x51, 0x35, 0x51, 0x51, 0x19, 0x01, 0x00,
]

proc logDebug(action: string, extra: JsonNode = nil) =
  if driverDebugLogsEnabled():
    var payload = %*{"event": "driver:inky:debug", "action": action}
    if extra != nil and extra.kind == JObject:
      for key, value in extra.pairs:
        payload[key] = value
    logDriverDebug(payload)

proc panelForDevice*(device: string): PanelSpec =
  case device
  of "pimoroni.inky_impression_7_3", "pimoroni.inky_impression_7_color":
    PanelSpec(kind: InkyImpression7Color, device: device, width: 800, height: 480, colorOption: ColorOption.SevenColor)
  of "pimoroni.inky_impression_5_7", "pimoroni.inky_impression_5_7_color":
    PanelSpec(kind: InkyImpression57Uc8159, device: device, width: 600, height: 448, colorOption: ColorOption.SevenColor)
  of "pimoroni.inky_impression_4_7_color":
    PanelSpec(kind: InkyImpression4Uc8159, device: device, width: 640, height: 400, colorOption: ColorOption.SevenColor)
  of "pimoroni.inky_impression_4", "pimoroni.inky_impression_4_2025", "pimoroni.inky_impression_4_spectra6":
    PanelSpec(kind: InkyImpression4Spectra6, device: device, width: 600, height: 400, colorOption: ColorOption.SpectraSixColor)
  of "pimoroni.inky_impression_7", "pimoroni.inky_impression_7_2025":
    PanelSpec(kind: InkyImpression73Spectra6, device: device, width: 800, height: 480, colorOption: ColorOption.SpectraSixColor)
  of "pimoroni.inky_impression_13", "pimoroni.inky_impression_13_2025":
    PanelSpec(kind: InkyImpression133Spectra6, device: device, width: 1600, height: 1200, colorOption: ColorOption.SpectraSixColor)
  of "pimoroni.inky_phat_4", "pimoroni.inky_phat_4_color", "pimoroni.inky_phat_jd79661":
    PanelSpec(kind: InkyPhatJd79661, device: device, width: 250, height: 122, colorOption: ColorOption.BlackWhiteYellowRed)
  of "pimoroni.inky_phat_black":
    PanelSpec(kind: InkyPhatLegacy, device: device, width: 212, height: 104, colorOption: ColorOption.Black, accent: AccentBlack)
  of "pimoroni.inky_phat_red":
    PanelSpec(kind: InkyPhatLegacy, device: device, width: 212, height: 104, colorOption: ColorOption.BlackWhiteRed, accent: AccentRed)
  of "pimoroni.inky_phat_red_ht":
    PanelSpec(kind: InkyPhatLegacy, device: device, width: 212, height: 104, colorOption: ColorOption.BlackWhiteRed, accent: AccentRedHighTemp)
  of "pimoroni.inky_phat_yellow":
    PanelSpec(kind: InkyPhatLegacy, device: device, width: 212, height: 104, colorOption: ColorOption.BlackWhiteYellow, accent: AccentYellow)
  of "pimoroni.inky_phat_ssd1608", "pimoroni.inky_phat_ssd1608_black":
    PanelSpec(kind: InkyPhatSsd1608, device: device, width: 250, height: 122, colorOption: ColorOption.Black, accent: AccentBlack)
  of "pimoroni.inky_phat_ssd1608_red":
    PanelSpec(kind: InkyPhatSsd1608, device: device, width: 250, height: 122, colorOption: ColorOption.BlackWhiteRed, accent: AccentRed)
  of "pimoroni.inky_phat_ssd1608_yellow":
    PanelSpec(kind: InkyPhatSsd1608, device: device, width: 250, height: 122, colorOption: ColorOption.BlackWhiteYellow, accent: AccentYellow)
  of "pimoroni.inky_what_4", "pimoroni.inky_what_4_color", "pimoroni.inky_what_jd79668":
    PanelSpec(kind: InkyWhatJd79668, device: device, width: 400, height: 300, colorOption: ColorOption.BlackWhiteYellowRed)
  of "pimoroni.inky_what_black":
    PanelSpec(kind: InkyWhatLegacy, device: device, width: 400, height: 300, colorOption: ColorOption.Black, accent: AccentBlack)
  of "pimoroni.inky_what_red":
    PanelSpec(kind: InkyWhatLegacy, device: device, width: 400, height: 300, colorOption: ColorOption.BlackWhiteRed, accent: AccentRed)
  of "pimoroni.inky_what_red_ht":
    PanelSpec(kind: InkyWhatLegacy, device: device, width: 400, height: 300, colorOption: ColorOption.BlackWhiteRed, accent: AccentRedHighTemp)
  of "pimoroni.inky_what_yellow", "pimoroni.inky_what_legacy_yellow":
    PanelSpec(kind: InkyWhatLegacy, device: device, width: 400, height: 300, colorOption: ColorOption.BlackWhiteYellow, accent: AccentYellow)
  of "pimoroni.inky_what_ssd1683", "pimoroni.inky_what_ssd1683_black":
    PanelSpec(kind: InkyWhatSsd1683, device: device, width: 400, height: 300, colorOption: ColorOption.Black, accent: AccentBlack)
  of "pimoroni.inky_what_ssd1683_red":
    PanelSpec(kind: InkyWhatSsd1683, device: device, width: 400, height: 300, colorOption: ColorOption.BlackWhiteRed, accent: AccentRed)
  of "pimoroni.inky_what_ssd1683_yellow":
    PanelSpec(kind: InkyWhatSsd1683, device: device, width: 400, height: 300, colorOption: ColorOption.BlackWhiteYellow, accent: AccentYellow)
  else:
    raise newException(ValueError, "Unsupported native Inky device: " & device)

proc pinsForPanel(panel: PanelSpec): InkyPins =
  case panel.kind
  of InkyImpression133Spectra6:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 26, cs1: 16, hasCs1: true, spiBaud: 10_000_000, spiChannel: 0)
  of InkyImpression7Color:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 8, cs1: 0, hasCs1: false, spiBaud: 5_000_000, spiChannel: 0)
  of InkyImpression57Uc8159, InkyImpression4Uc8159:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 8, cs1: 0, hasCs1: false, spiBaud: 3_000_000, spiChannel: 0)
  of InkyImpression4Spectra6, InkyImpression73Spectra6:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 8, cs1: 0, hasCs1: false, spiBaud: 1_000_000, spiChannel: 0)
  of InkyPhatJd79661, InkyWhatJd79668:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 8, cs1: 0, hasCs1: false, spiBaud: 1_000_000, spiChannel: 0)
  of InkyPhatLegacy, InkyPhatSsd1608, InkyWhatLegacy:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 8, cs1: 0, hasCs1: false, spiBaud: 488_000, spiChannel: 0)
  of InkyWhatSsd1683:
    InkyPins(reset: 27, busy: 17, dc: 22, cs0: 8, cs1: 0, hasCs1: false, spiBaud: 10_000_000, spiChannel: 0)

proc initHardware*(panel: PanelSpec) =
  let pins = pinsForPanel(panel)
  if not hal.init(pins):
    raise newException(OSError, "Failed to initialize native Inky GPIO/SPI")

proc packedRowWidth(width: int): int {.inline.} =
  (width + 1) div 2

proc packedPixel(pixels: openArray[uint8]; width, x, y: int): uint8 {.inline.} =
  let index = y * packedRowWidth(width) + x div 2
  if (x and 1) == 0:
    (pixels[index] shr 4) and 0x0F'u8
  else:
    pixels[index] and 0x0F'u8

proc setPackedPixel(pixels: var seq[uint8]; width, x, y: int; value: uint8) {.inline.} =
  let index = y * packedRowWidth(width) + x div 2
  if (x and 1) == 0:
    pixels[index] = pixels[index] or ((value and 0x0F'u8) shl 4)
  else:
    pixels[index] = pixels[index] or (value and 0x0F'u8)

proc packedTwoBitRowWidth(width: int): int {.inline.} =
  (width + 3) div 4

proc packedTwoBitPixel(pixels: openArray[uint8]; width, x, y: int): uint8 {.inline.} =
  let
    index = y * packedTwoBitRowWidth(width) + x div 4
    shift = (3 - (x mod 4)) * 2
  (pixels[index] shr shift) and 0x03'u8

proc setPackedTwoBitPixel(pixels: var seq[uint8]; width, x, y: int; value: uint8) {.inline.} =
  let
    index = y * packedTwoBitRowWidth(width) + x div 4
    shift = (3 - (x mod 4)) * 2
  pixels[index] = pixels[index] or ((value and 0x03'u8) shl shift)

proc packedOneBitPixel(pixels: openArray[uint8]; width, x, y: int): uint8 {.inline.} =
  let
    index = y * ((width + 7) div 8) + x div 8
    shift = 7 - (x mod 8)
  (pixels[index] shr shift) and 0x01'u8

proc rotatePackedClockwise(pixels: openArray[uint8]; sourceWidth, sourceHeight: int): seq[uint8] =
  let
    destWidth = sourceHeight
    destHeight = sourceWidth
  result = newSeq[uint8](packedRowWidth(destWidth) * destHeight)

  for y in 0 ..< sourceHeight:
    for x in 0 ..< sourceWidth:
      let value = packedPixel(pixels, sourceWidth, x, y)
      setPackedPixel(result, destWidth, sourceHeight - 1 - y, x, value)

proc splitRotatedClockwisePacked(pixels: openArray[uint8]; sourceWidth, sourceHeight: int): tuple[left, right: seq[uint8]] =
  let
    destWidth = sourceHeight
    destHeight = sourceWidth
    halfWidth = destWidth div 2
  result.left = newSeq[uint8](packedRowWidth(halfWidth) * destHeight)
  result.right = newSeq[uint8](packedRowWidth(halfWidth) * destHeight)

  for y in 0 ..< sourceHeight:
    for x in 0 ..< sourceWidth:
      let
        value = packedPixel(pixels, sourceWidth, x, y)
        destX = sourceHeight - 1 - y
        destY = x
      if destX < halfWidth:
        setPackedPixel(result.left, halfWidth, destX, destY, value)
      else:
        setPackedPixel(result.right, halfWidth, destX - halfWidth, destY, value)

proc rotatedPhatFourColorBuffer(pixels: openArray[uint8]): seq[uint8] =
  const
    sourceWidth = 250
    sourceHeight = 122
    overscanRows = 6
    regionHeight = sourceHeight + overscanRows
    destWidth = regionHeight
    destHeight = sourceWidth

  result = newSeq[uint8](packedTwoBitRowWidth(destWidth) * destHeight)
  for y in 0 ..< regionHeight:
    for x in 0 ..< sourceWidth:
      let
        value = if y < overscanRows: 0'u8 else: packedTwoBitPixel(pixels, sourceWidth, x, y - overscanRows)
        destX = regionHeight - 1 - y
        destY = x
      setPackedTwoBitPixel(result, destWidth, destX, destY, value)

proc setPlanePixel(planes: var tuple[black, color: seq[uint8]]; width, x, y: int; value: uint8; colorOption: ColorOption) =
  let
    outputIndex = y * ((width + 7) div 8) + x div 8
    shift = 7 - (x mod 8)
    mask = 1'u8 shl shift
    blackBit = if value == 0'u8: 0'u8 else: 1'u8
    colorBit = if colorOption == ColorOption.Black: 0'u8 elif value == 1'u8: 1'u8 else: 0'u8
  if blackBit == 0'u8:
    planes.black[outputIndex] = planes.black[outputIndex] and (mask xor 0xFF'u8)
  else:
    planes.black[outputIndex] = planes.black[outputIndex] or mask
  if colorBit == 1'u8:
    planes.color[outputIndex] = planes.color[outputIndex] or mask

proc triColorPixel(pixels: openArray[uint8]; colorOption: ColorOption; width, x, y: int): uint8 =
  if colorOption == ColorOption.Black:
    packedOneBitPixel(pixels, width, x, y)
  else:
    packedTwoBitPixel(pixels, width, x, y)

proc panelPlanes(
    pixels: openArray[uint8],
    colorOption: ColorOption,
    sourceWidth, sourceHeight, transferWidth, transferHeight: int,
    rotateClockwise = false,
    offsetY = 0
  ): tuple[black, color: seq[uint8]] =
  let rowWidth = (transferWidth + 7) div 8
  result.black = newSeq[uint8](rowWidth * transferHeight)
  result.color = newSeq[uint8](rowWidth * transferHeight)
  for i in 0 ..< result.black.len:
    result.black[i] = 0xFF'u8

  for y in 0 ..< sourceHeight:
    for x in 0 ..< sourceWidth:
      let
        value = triColorPixel(pixels, colorOption, sourceWidth, x, y)
        canvasY = y + offsetY
        destX = if rotateClockwise: transferWidth - 1 - canvasY else: x
        destY = if rotateClockwise: x else: canvasY
      setPlanePixel(result, transferWidth, destX, destY, value, colorOption)

proc replaceCleanWithWhite(pixels: var seq[uint8]) =
  for i in 0 ..< pixels.len:
    if (pixels[i] and 0x0F'u8) == 0x07'u8:
      pixels[i] = (pixels[i] and 0xF0'u8) or 0x01'u8
    if (pixels[i] and 0xF0'u8) == 0x70'u8:
      pixels[i] = (pixels[i] and 0x0F'u8) or 0x10'u8

proc start7Color() =
  hal.reset(100, 100, doublePulse = true)
  hal.busyWaitHigh(1000)

  hal.sendCommand(Ac073Cmdh, [0x49'u8, 0x55, 0x20, 0x08, 0x09, 0x18])
  hal.sendCommand(Ac073Pwr, [0x3F'u8, 0x00, 0x32, 0x2A, 0x0E, 0x2A])
  hal.sendCommand(Ac073Psr, [0x5F'u8, 0x69])
  hal.sendCommand(Ac073Pofs, [0x00'u8, 0x54, 0x00, 0x44])
  hal.sendCommand(Ac073Btst1, [0x40'u8, 0x1F, 0x1F, 0x2C])
  hal.sendCommand(Ac073Btst2, [0x6F'u8, 0x1F, 0x16, 0x25])
  hal.sendCommand(Ac073Btst3, [0x6F'u8, 0x1F, 0x1F, 0x22])
  hal.sendCommand(Ac073Ipc, [0x00'u8, 0x04])
  hal.sendCommand(Ac073Pll, [0x02'u8])
  hal.sendCommand(Ac073Tse, [0x00'u8])
  hal.sendCommand(Ac073Cdi, [0x3F'u8])
  hal.sendCommand(Ac073Tcon, [0x02'u8, 0x00])
  hal.sendCommand(Ac073Tres, [0x03'u8, 0x20, 0x01, 0xE0])
  hal.sendCommand(Ac073Vdcs, [0x1E'u8])
  hal.sendCommand(Ac073TVdcs, [0x00'u8])
  hal.sendCommand(Ac073Agid, [0x00'u8])
  hal.sendCommand(Ac073Pws, [0x2F'u8])
  hal.sendCommand(Ac073Ccset, [0x00'u8])
  hal.sendCommand(Ac073Tsset, [0x00'u8])

proc startUc8159(width, height, resolutionSetting: int) =
  hal.reset(100, 100)
  hal.busyWaitHigh(1000)

  hal.sendCommand(Uc8159Tres, [(width shr 8).uint8, (width and 0xFF).uint8, (height shr 8).uint8, (height and 0xFF).uint8])
  hal.sendCommand(Uc8159Psr, [((resolutionSetting shl 6) or 0b101111).uint8, 0x08'u8])
  hal.sendCommand(Uc8159Pwr, [0x37'u8, 0x00, 0x23, 0x23])
  hal.sendCommand(Uc8159Pll, [0x3C'u8])
  hal.sendCommand(Uc8159Tse, [0x00'u8])
  hal.sendCommand(Uc8159Cdi, [0x37'u8])
  hal.sendCommand(Uc8159Tcon, [0x22'u8])
  hal.sendCommand(Uc8159Dam, [0x00'u8])
  hal.sendCommand(Uc8159Pws, [0xAA'u8])
  hal.sendCommand(Uc8159Pfs, [0x00'u8])

proc startSpectra4() =
  hal.reset(30, 30)
  hal.busyWaitHigh(300)

  hal.sendCommand(0xAA'u8, [0x49'u8, 0x55, 0x20, 0x08, 0x09, 0x18], commandDelayMs = 300)
  hal.sendCommand(SpectraPwr, [0x3F'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraPsr, [0x5F'u8, 0x69], commandDelayMs = 300)
  hal.sendCommand(SpectraBtst1, [0x40'u8, 0x1F, 0x1F, 0x2C], commandDelayMs = 300)
  hal.sendCommand(SpectraBtst3, [0x6F'u8, 0x1F, 0x1F, 0x22], commandDelayMs = 300)
  hal.sendCommand(SpectraBtst2, [0x6F'u8, 0x1F, 0x17, 0x17], commandDelayMs = 300)
  hal.sendCommand(SpectraPofs, [0x00'u8, 0x54, 0x00, 0x44], commandDelayMs = 300)
  hal.sendCommand(SpectraTcon, [0x02'u8, 0x00], commandDelayMs = 300)
  hal.sendCommand(SpectraPll, [0x08'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraCdi, [0x3F'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraTres, [0x01'u8, 0x90, 0x02, 0x58], commandDelayMs = 300)
  hal.sendCommand(SpectraPws, [0x2F'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraVdcs, [0x01'u8], commandDelayMs = 300)

proc startSpectra73() =
  hal.reset(30, 30)
  hal.busyWaitHigh(300)

  hal.sendCommand(0xAA'u8, [0x49'u8, 0x55, 0x20, 0x08, 0x09, 0x18], commandDelayMs = 300)
  hal.sendCommand(SpectraPwr, [0x3F'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraPsr, [0x5F'u8, 0x69], commandDelayMs = 300)
  hal.sendCommand(SpectraBtst1, [0x40'u8, 0x1F, 0x1F, 0x2C], commandDelayMs = 300)
  hal.sendCommand(SpectraBtst3, [0x6F'u8, 0x1F, 0x1F, 0x22], commandDelayMs = 300)
  hal.sendCommand(SpectraBtst2, [0x6F'u8, 0x1F, 0x17, 0x17], commandDelayMs = 300)
  hal.sendCommand(SpectraPofs, [0x00'u8, 0x54, 0x00, 0x44], commandDelayMs = 300)
  hal.sendCommand(SpectraTcon, [0x02'u8, 0x00], commandDelayMs = 300)
  hal.sendCommand(SpectraPll, [0x08'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraCdi, [0x3F'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraTres, [0x03'u8, 0x20, 0x01, 0xE0], commandDelayMs = 300)
  hal.sendCommand(SpectraPws, [0x2F'u8], commandDelayMs = 300)
  hal.sendCommand(SpectraVdcs, [0x01'u8], commandDelayMs = 300)

proc startSpectra133() =
  hal.reset(30, 30)
  hal.busyWaitHigh(300)

  hal.sendCommand(El133Antm, [0x00'u8, 0x0C, 0x0C, 0xD9, 0xDD, 0xDD, 0x15, 0x15, 0x55], Cs0, 300)
  hal.sendCommand(El133Cmd66, [0x49'u8, 0x55, 0x13, 0x5D, 0x05, 0x10], CsBoth, 300)
  hal.sendCommand(El133Psr, [0xDF'u8, 0x6B], CsBoth, 300)
  hal.sendCommand(El133Dcdc, [0x44'u8, 0x54, 0x00], Cs0, 300)
  hal.sendCommand(El133Pll, [0x08'u8], CsBoth, 300)
  hal.sendCommand(El133Cdi, [0x37'u8], CsBoth, 300)
  hal.sendCommand(El133Tcon, [0x03'u8, 0x03], CsBoth, 300)
  hal.sendCommand(El133Pofs, [0x00'u8, 0xC0, 0x03, 0xA8], Cs0, 300)
  hal.sendCommand(El133Pofs, [0x00'u8, 0xC0, 0x03, 0x9A], Cs1, 300)
  hal.sendCommand(El133Agid, [0x10'u8], CsBoth, 300)
  hal.sendCommand(El133Pws, [0x22'u8], CsBoth, 300)
  hal.sendCommand(El133Ccset, [0x01'u8], CsBoth, 300)
  hal.sendCommand(El133Tres, [0x04'u8, 0xB0, 0x03, 0x20], CsBoth, 300)
  hal.sendCommand(El133CmdA4, [0x03'u8, 0x00, 0x01, 0x03, 0x00, 0x03, 0x00, 0x00, 0x00], Cs0, 300)
  hal.sendCommand(El133Pwr, [0x0F'u8, 0x00, 0x28, 0x2C, 0x28, 0x38], Cs0, 300)
  hal.sendCommand(El133EnBuf, [0x07'u8], Cs0, 300)
  hal.sendCommand(El133BtstP, [0xE0'u8, 0x20], Cs0, 300)
  hal.sendCommand(El133BoostVddpEn, [0x01'u8], Cs0, 300)
  hal.sendCommand(El133BtstN, [0xE0'u8, 0x20], Cs0, 300)
  hal.sendCommand(El133BuckBoostVddn, [0x01'u8], Cs0, 300)
  hal.sendCommand(El133TftVcomPower, [0x02'u8], Cs0, 300)

proc startJd79661() =
  hal.reset(30, 30)

  hal.sendCommand(0x4D'u8, [0x78'u8], commandDelayMs = 300)
  hal.sendCommand(JdPsr, [0x0F'u8, 0x29], commandDelayMs = 300)
  hal.sendCommand(JdPwr, [0x07'u8, 0x00], commandDelayMs = 300)
  hal.sendCommand(JdPofs, [0x10'u8, 0x54, 0x44], commandDelayMs = 300)
  hal.sendCommand(JdBtstP, [0x0F'u8, 0x0A, 0x2F, 0x25, 0x22, 0x2E, 0x21], commandDelayMs = 300)
  hal.sendCommand(JdCdi, [0x37'u8], commandDelayMs = 300)
  hal.sendCommand(JdTcon, [0x02'u8, 0x02], commandDelayMs = 300)
  hal.sendCommand(JdTres, [0x00'u8, 0x80, 0x00, 0xFA], commandDelayMs = 300)
  hal.sendCommand(0xE7'u8, [0x1C'u8], commandDelayMs = 300)
  hal.sendCommand(JdPws, [0x22'u8], commandDelayMs = 300)
  hal.sendCommand(0xB6'u8, [0x6F'u8], commandDelayMs = 300)
  hal.sendCommand(0xB4'u8, [0xD0'u8], commandDelayMs = 300)
  hal.sendCommand(0xE9'u8, [0x01'u8], commandDelayMs = 300)
  hal.sendCommand(0x30'u8, [0x08'u8], commandDelayMs = 300)

proc startJd79668() =
  hal.reset(30, 30)

  hal.sendCommand(0x4D'u8, [0x78'u8], commandDelayMs = 300)
  hal.sendCommand(JdPsr, [0x0F'u8, 0x29], commandDelayMs = 300)
  hal.sendCommand(JdBtstP, [0x0D'u8, 0x12, 0x24, 0x25, 0x12, 0x29, 0x10], commandDelayMs = 300)
  hal.sendCommand(0x30'u8, [0x08'u8], commandDelayMs = 300)
  hal.sendCommand(JdCdi, [0x37'u8], commandDelayMs = 300)
  hal.sendCommand(JdTres, [0x01'u8, 0x90, 0x01, 0x2C], commandDelayMs = 300)
  hal.sendCommand(0xAE'u8, [0xCF'u8], commandDelayMs = 300)
  hal.sendCommand(0xB0'u8, [0x13'u8], commandDelayMs = 300)
  hal.sendCommand(0xBD'u8, [0x07'u8], commandDelayMs = 300)
  hal.sendCommand(0xBE'u8, [0xFE'u8], commandDelayMs = 300)
  hal.sendCommand(0xE9'u8, [0x01'u8], commandDelayMs = 300)

proc startLegacyInky() =
  hal.reset(100, 100)
  hal.sendCommand(SsdSwReset)
  hal.busyWaitLow(1000)

proc startSsd1608Inky() =
  hal.reset(500, 500)
  hal.sendCommand(SsdSwReset)
  hal.delayMs(1000)
  hal.busyWaitLow(5000)

proc startSsd1683What() =
  hal.reset(500, 500)
  hal.sendCommand(SsdSwReset)
  hal.delayMs(1000)
  hal.busyWaitLow(30_000)

proc start*(panel: PanelSpec) =
  logDebug("panel:start", %*{"device": panel.device, "kind": $panel.kind})
  case panel.kind
  of InkyImpression7Color:
    start7Color()
  of InkyImpression57Uc8159:
    startUc8159(600, 448, 0b11)
  of InkyImpression4Uc8159:
    startUc8159(640, 400, 0b10)
  of InkyImpression4Spectra6:
    startSpectra4()
  of InkyImpression73Spectra6:
    startSpectra73()
  of InkyImpression133Spectra6:
    startSpectra133()
  of InkyPhatJd79661:
    startJd79661()
  of InkyWhatJd79668:
    startJd79668()
  of InkyPhatLegacy, InkyWhatLegacy:
    startLegacyInky()
  of InkyPhatSsd1608:
    startSsd1608Inky()
  of InkyWhatSsd1683:
    startSsd1683What()

proc render7Color(pixels: openArray[uint8]) =
  var buffer = @pixels
  replaceCleanWithWhite(buffer)
  hal.sendCommand(Ac073Dtm, buffer)
  hal.sendCommand(Ac073Pon)
  hal.busyWaitHigh(400)
  hal.sendCommand(Ac073Drf, [0x00'u8])
  hal.busyWaitHigh(45_000)
  hal.sendCommand(Ac073Pof, [0x00'u8])
  hal.busyWaitHigh(400)

proc renderUc8159(pixels: openArray[uint8]) =
  hal.sendCommand(Uc8159Dtm1, pixels)
  hal.sendCommand(Uc8159Pon)
  hal.busyWaitHigh(200)
  hal.sendCommand(Uc8159Drf)
  hal.busyWaitHigh(32_000)
  hal.sendCommand(Uc8159Pof)
  hal.busyWaitHigh(200)

proc renderSpectra4(pixels: openArray[uint8]) =
  let rotated = rotatePackedClockwise(pixels, 600, 400)
  hal.sendCommand(SpectraDtm1, rotated, commandDelayMs = 300)
  hal.sendCommand(SpectraPon, commandDelayMs = 300)
  hal.busyWaitHigh(300)
  hal.sendCommand(SpectraBtst2, [0x6F'u8, 0x1F, 0x17, 0x47], commandDelayMs = 300)
  hal.sendCommand(SpectraDrf, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(SpectraPof, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(300)

proc renderSpectra73(pixels: openArray[uint8]) =
  hal.sendCommand(SpectraDtm1, pixels, commandDelayMs = 300)
  hal.sendCommand(SpectraPon, commandDelayMs = 300)
  hal.busyWaitHigh(300)
  hal.sendCommand(SpectraBtst2, [0x6F'u8, 0x1F, 0x17, 0x49], commandDelayMs = 300)
  hal.sendCommand(SpectraDrf, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(32_000)
  hal.sendCommand(SpectraPof, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(300)
  hal.sendCommand(SpectraPsr, [0x4F'u8, 0x6E], commandDelayMs = 300)
  hal.busyWaitHigh(300)

proc renderSpectra133(pixels: openArray[uint8]) =
  let buffers = splitRotatedClockwisePacked(pixels, 1600, 1200)
  hal.sendCommand(El133Dtm, buffers.left, Cs0, 300)
  hal.sendCommand(El133Dtm, buffers.right, Cs1, 300)
  hal.sendCommand(El133Pon, CsBoth, 300)
  hal.busyWaitHigh(200)
  hal.sendCommand(El133Drf, [0x00'u8], CsBoth, 300)
  hal.busyWaitHigh(32_000)
  hal.sendCommand(El133Pof, [0x00'u8], CsBoth, 300)
  hal.busyWaitHigh(200)

proc renderJd79661(pixels: openArray[uint8]) =
  let buffer = rotatedPhatFourColorBuffer(pixels)
  hal.sendCommand(JdDtm, buffer, commandDelayMs = 300)
  hal.sendCommand(JdPon, commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(JdDrf, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(JdPof, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(JdDslp, [0xA5'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)

proc renderJd79668(pixels: openArray[uint8]) =
  hal.sendCommand(JdDtm, pixels, commandDelayMs = 300)
  hal.sendCommand(JdPon, commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(JdDrf, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(JdPof, [0x00'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)
  hal.sendCommand(JdDslp, [0xA5'u8], commandDelayMs = 300)
  hal.busyWaitHigh(40_000)

proc sendLegacyLut(panel: PanelSpec) =
  case panel.accent
  of AccentBlack:
    hal.sendCommand(SsdWriteLut, LegacyBlackLut)
  of AccentRed:
    hal.sendCommand(SsdWriteLut, LegacyRedLut)
  of AccentRedHighTemp:
    hal.sendCommand(SsdWriteLut, LegacyRedHighTempLut)
  of AccentYellow:
    hal.sendCommand(SsdWriteLut, LegacyYellowLut)
  else:
    raise newException(ValueError, "Legacy Inky panel requires a LUT accent")

proc renderLegacyTriColor(panel: PanelSpec; pixels: openArray[uint8]) =
  let
    transferWidth = if panel.kind == InkyPhatLegacy: 104 else: 400
    transferHeight = if panel.kind == InkyPhatLegacy: 212 else: 300
    planes = panelPlanes(pixels, panel.colorOption, panel.width, panel.height, transferWidth, transferHeight,
      rotateClockwise = panel.kind == InkyPhatLegacy)
    packedHeight = [(transferHeight and 0xFF).uint8, (transferHeight shr 8).uint8]

  hal.sendCommand(0x74'u8, [0x54'u8])
  hal.sendCommand(0x7E'u8, [0x3B'u8])
  hal.sendCommand(SsdDriverControl, [packedHeight[0], packedHeight[1], 0x00])
  hal.sendCommand(SsdGateVoltage, [0x17'u8])
  hal.sendCommand(SsdSourceVoltage, [0x41'u8, 0xAC, 0x32])
  hal.sendCommand(SsdWriteDummy, [0x07'u8])
  hal.sendCommand(SsdWriteGateline, [0x04'u8])
  hal.sendCommand(SsdDataMode, [0x03'u8])
  hal.sendCommand(SsdWriteVcom, [0x3C'u8])
  hal.sendCommand(SsdWriteBorder, [0x00'u8])
  hal.sendCommand(SsdWriteBorder, [0b00110001'u8])

  if panel.accent == AccentYellow:
    hal.sendCommand(SsdSourceVoltage, [0x07'u8, 0xAC, 0x32])
  elif panel.accent in {AccentRed, AccentRedHighTemp} and panel.kind == InkyWhatLegacy:
    hal.sendCommand(SsdSourceVoltage, [0x30'u8, 0xAC, 0x22])

  sendLegacyLut(panel)
  hal.sendCommand(SsdSetRamXPos, [0x00'u8, (transferWidth div 8 - 1).uint8])
  hal.sendCommand(SsdSetRamYPos, [0x00'u8, 0x00, packedHeight[0], packedHeight[1]])

  hal.sendCommand(SsdSetRamXCount, [0x00'u8])
  hal.sendCommand(SsdSetRamYCount, [0x00'u8, 0x00])
  hal.sendCommand(SsdWriteRam, planes.black)
  hal.sendCommand(SsdSetRamXCount, [0x00'u8])
  hal.sendCommand(SsdSetRamYCount, [0x00'u8, 0x00])
  hal.sendCommand(SsdWriteAltRam, planes.color)

  hal.sendCommand(0x22'u8, [0xC7'u8])
  hal.sendCommand(SsdMasterActivate)
  hal.delayMs(50)
  hal.busyWaitLow(30_000)
  hal.sendCommand(SsdDeepSleep, [0x01'u8])

proc renderSsd1608Phat(panel: PanelSpec; pixels: openArray[uint8]) =
  let
    transferWidth = 136
    transferHeight = 250
    planes = panelPlanes(pixels, panel.colorOption, panel.width, panel.height, transferWidth, transferHeight,
      rotateClockwise = true, offsetY = 6)

  hal.sendCommand(SsdDriverControl, [((transferHeight - 1) and 0xFF).uint8, ((transferHeight - 1) shr 8).uint8, 0x00])
  hal.sendCommand(SsdWriteDummy, [0x1B'u8])
  hal.sendCommand(SsdWriteGateline, [0x0B'u8])
  hal.sendCommand(SsdDataMode, [0x03'u8])
  hal.sendCommand(SsdSetRamXPos, [0x00'u8, (transferWidth div 8 - 1).uint8])
  hal.sendCommand(SsdSetRamYPos, [0x00'u8, 0x00, ((transferHeight - 1) and 0xFF).uint8, ((transferHeight - 1) shr 8).uint8])
  hal.sendCommand(SsdWriteVcom, [0x70'u8])
  hal.sendCommand(SsdWriteLut, Ssd1608Lut)
  hal.sendCommand(SsdWriteBorder, [0b00000001'u8])
  hal.sendCommand(SsdSetRamXCount, [0x00'u8])
  hal.sendCommand(SsdSetRamYCount, [0x00'u8, 0x00])
  hal.sendCommand(SsdWriteRam, planes.black)
  hal.sendCommand(SsdSetRamXCount, [0x00'u8])
  hal.sendCommand(SsdSetRamYCount, [0x00'u8, 0x00])
  hal.sendCommand(SsdWriteAltRam, planes.color)

  hal.busyWaitLow(5000)
  hal.sendCommand(SsdMasterActivate)

proc renderSsd1683What(panel: PanelSpec; pixels: openArray[uint8]) =
  let planes = panelPlanes(pixels, panel.colorOption, 400, 300, 400, 300)

  hal.sendCommand(SsdDriverControl, [0x2B'u8, 0x01, 0x00])
  hal.sendCommand(SsdWriteDummy, [0x1B'u8])
  hal.sendCommand(SsdWriteGateline, [0x0B'u8])
  hal.sendCommand(SsdDataMode, [0x03'u8])
  hal.sendCommand(SsdSetRamXPos, [0x00'u8, 0x31])
  hal.sendCommand(SsdSetRamYPos, [0x00'u8, 0x00, 0x2B, 0x01])
  hal.sendCommand(SsdWriteVcom, [0x70'u8])
  hal.sendCommand(SsdWriteBorder, [0b00000001'u8])
  hal.sendCommand(SsdSetRamXCount, [0x00'u8])
  hal.sendCommand(SsdSetRamYCount, [0x00'u8, 0x00])
  hal.sendCommand(SsdWriteRam, planes.black)
  hal.sendCommand(SsdWriteAltRam, planes.color)
  hal.busyWaitLow(30_000)
  hal.sendCommand(SsdMasterActivate)

proc renderPacked*(panel: PanelSpec; pixels: openArray[uint8]) =
  logDebug("panel:render", %*{"device": panel.device, "kind": $panel.kind, "bytes": pixels.len})
  case panel.kind
  of InkyImpression7Color:
    render7Color(pixels)
  of InkyImpression57Uc8159, InkyImpression4Uc8159:
    renderUc8159(pixels)
  of InkyImpression4Spectra6:
    renderSpectra4(pixels)
  of InkyImpression73Spectra6:
    renderSpectra73(pixels)
  of InkyImpression133Spectra6:
    renderSpectra133(pixels)
  of InkyPhatJd79661:
    renderJd79661(pixels)
  of InkyWhatJd79668:
    renderJd79668(pixels)
  of InkyPhatLegacy, InkyWhatLegacy:
    renderLegacyTriColor(panel, pixels)
  of InkyPhatSsd1608:
    renderSsd1608Phat(panel, pixels)
  of InkyWhatSsd1683:
    renderSsd1683What(panel, pixels)

proc sleep*(panel: PanelSpec) =
  discard panel
  hal.deselectAllCs()

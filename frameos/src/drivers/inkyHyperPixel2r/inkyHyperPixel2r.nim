import json, pixie, strformat, strutils

import lib/lgpio
import frameos/driver_context
import frameos/device_setup

import drivers/frameBuffer/frameBuffer as frameBuffer

const
  GpioClk = 11
  GpioMosi = 10
  GpioCs = 18
  GpioBacklight = 19
  BitDelaySeconds = 0.00001
  PanelWidth = 480
  PanelHeight = 480
  # Pixels are carried by Raspberry Pi DPI into /dev/fb0; lgpio only owns the
  # ST7701 sideband init bus and backlight GPIOs.
  HyperPixelBootConfigLines* = @[
    "#dtoverlay=vc4-kms-dpi-hyperpixel2r",
    "#dtoverlay=vc4-kms-v3d",
    "#dtoverlay=vc4-fkms-v3d",
    "dtparam=i2c_arm=off",
    "dtparam=spi=off",
    "enable_dpi_lcd=1",
    "display_default_lcd=1",
    "dpi_group=2",
    "dpi_mode=87",
    "dpi_output_format=0x7f216",
    "dpi_timings=480 0 10 16 55 480 0 15 60 15 0 0 0 60 0 19200000 6",
    "gpio=0-9=a2,np",
    "gpio=12-17=a2,np",
    "gpio=20-25=a2,np",
    "gpio=19=op,dh",
  ]

type Driver* = ref object of frameBuffer.Driver
  mode*: string
  gpioHandle: cint
  panelInitialized: bool

proc log(self: Driver; payload: JsonNode) =
  if not self.isNil and not self.logger.isNil and not self.logger.log.isNil:
    self.logger.log(payload)

proc determineGpioChip(): cint =
  try:
    if readFile("/proc/cpuinfo").contains("Raspberry Pi 5"):
      return 4
  except CatchableError:
    discard
  0

proc delaySeconds(seconds: float) =
  if seconds > 0:
    lguSleep(seconds)

proc delayMs(milliseconds: int) =
  delaySeconds(milliseconds.float / 1000.0)

proc writePin(self: Driver; pin: int; value: int) =
  discard lgGpioWrite(self.gpioHandle, pin.cint, value.cint)

proc claimOutput(self: Driver; pin: int; level: int) =
  let res = lgGpioClaimOutput(self.gpioHandle, 0, pin.cint, level.cint)
  if res < 0:
    raise newException(OSError, &"Unable to claim GPIO {pin} for HyperPixel 2.1R: {$lguErrorText(res)}")

proc ensureGpio(self: Driver) =
  if self.gpioHandle >= 0:
    return

  let gpioChip = determineGpioChip()
  self.gpioHandle = lgGpiochipOpen(gpioChip)
  if self.gpioHandle < 0:
    raise newException(OSError, &"Unable to open gpiochip{gpioChip}: {$lguErrorText(self.gpioHandle)}")

  self.claimOutput(GpioClk, LG_LOW)
  self.claimOutput(GpioMosi, LG_LOW)
  self.claimOutput(GpioCs, LG_HIGH)
  self.claimOutput(GpioBacklight, LG_HIGH)
  self.log(%*{"event": "driver:inkyHyperPixel2r", "gpiochip": gpioChip, "init": "gpio-ready"})

proc writeSpiWord(self: Driver; value: int) =
  var data = value and 0x1ff
  for _ in 0 ..< 9:
    self.writePin(GpioMosi, if (data and 0x100) != 0: LG_HIGH else: LG_LOW)
    data = (data shl 1) and 0x1ff
    delaySeconds(BitDelaySeconds)
    self.writePin(GpioClk, LG_HIGH)
    delaySeconds(BitDelaySeconds)
    self.writePin(GpioClk, LG_LOW)
  self.writePin(GpioMosi, LG_LOW)

proc sendCommand(self: Driver; command: uint8; data: openArray[uint8] = []) =
  self.ensureGpio()
  self.writePin(GpioCs, LG_LOW)
  self.writeSpiWord(command.int)
  for value in data:
    self.writeSpiWord(0x100 or value.int)
  self.writePin(GpioCs, LG_HIGH)

proc initializePanel(self: Driver) =
  if self.panelInitialized:
    return

  self.ensureGpio()
  self.log(%*{"event": "driver:inkyHyperPixel2r", "init": "panel-start"})

  # ST7701 command table from Pimoroni's userspace HyperPixel 2.1R init path.
  self.sendCommand(0x01'u8)
  delayMs(240)

  self.sendCommand(0xFF'u8, [0x77'u8, 0x01, 0x00, 0x00, 0x10])
  self.sendCommand(0xC0'u8, [0x3B'u8, 0x00])
  self.sendCommand(0xC1'u8, [0x0B'u8, 0x02])
  self.sendCommand(0xC2'u8, [0x00'u8, 0x02])
  self.sendCommand(0xCC'u8, [0x10'u8])
  self.sendCommand(0xB0'u8, [
    0x02'u8, 0x13, 0x1B, 0x0D, 0x10, 0x05, 0x08, 0x07,
    0x07, 0x24, 0x04, 0x11, 0x0E, 0x2C, 0x33, 0x1D
  ])
  self.sendCommand(0xB1'u8, [
    0x05'u8, 0x13, 0x1B, 0x0D, 0x11, 0x05, 0x08, 0x07,
    0x07, 0x24, 0x04, 0x11, 0x0E, 0x2C, 0x33, 0x1D
  ])

  self.sendCommand(0xFF'u8, [0x77'u8, 0x01, 0x00, 0x00, 0x11])
  self.sendCommand(0xB0'u8, [0x5D'u8])
  self.sendCommand(0xB1'u8, [0x43'u8])
  self.sendCommand(0xB2'u8, [0x81'u8])
  self.sendCommand(0xB3'u8, [0x80'u8])
  self.sendCommand(0xB5'u8, [0x43'u8])
  self.sendCommand(0xB7'u8, [0x85'u8])
  self.sendCommand(0xB8'u8, [0x20'u8])
  self.sendCommand(0xC1'u8, [0x78'u8])
  self.sendCommand(0xC2'u8, [0x78'u8])
  self.sendCommand(0xD0'u8, [0x88'u8])

  self.sendCommand(0xE0'u8, [0x00'u8, 0x00, 0x02])
  self.sendCommand(0xE1'u8, [0x03'u8, 0xA0, 0x00, 0x00, 0x04, 0xA0, 0x00, 0x00, 0x00, 0x20, 0x20])
  self.sendCommand(0xE2'u8, [0x00'u8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  self.sendCommand(0xE3'u8, [0x00'u8, 0x00, 0x11, 0x00])
  self.sendCommand(0xE4'u8, [0x22'u8, 0x00])
  self.sendCommand(0xE5'u8, [
    0x05'u8, 0xEC, 0xA0, 0xA0, 0x07, 0xEE, 0xA0, 0xA0,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ])
  self.sendCommand(0xE6'u8, [0x00'u8, 0x00, 0x11, 0x00])
  self.sendCommand(0xE7'u8, [0x22'u8, 0x00])
  self.sendCommand(0xE8'u8, [
    0x06'u8, 0xED, 0xA0, 0xA0, 0x08, 0xEF, 0xA0, 0xA0,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ])
  self.sendCommand(0xEB'u8, [0x00'u8, 0x00, 0x40, 0x40, 0x00, 0x00, 0x00])
  self.sendCommand(0xED'u8, [
    0xFF'u8, 0xFF, 0xFF, 0xBA, 0x0A, 0xBF, 0x45, 0xFF,
    0xFF, 0x54, 0xFB, 0xA0, 0xAB, 0xFF, 0xFF, 0xFF
  ])
  self.sendCommand(0xEF'u8, [0x10'u8, 0x0D, 0x04, 0x08, 0x3F, 0x1F])

  self.sendCommand(0xFF'u8, [0x77'u8, 0x01, 0x00, 0x00, 0x13])
  self.sendCommand(0xEF'u8, [0x08'u8])
  self.sendCommand(0xFF'u8, [0x77'u8, 0x01, 0x00, 0x00, 0x00])
  self.sendCommand(0xCD'u8, [0x08'u8])
  self.sendCommand(0x36'u8, [0x08'u8])
  self.sendCommand(0x3A'u8, [0x66'u8])

  self.sendCommand(0x11'u8)
  delayMs(120)
  self.sendCommand(0x29'u8)
  delayMs(20)

  self.writePin(GpioBacklight, LG_HIGH)
  self.panelInitialized = true
  self.log(%*{"event": "driver:inkyHyperPixel2r", "init": "panel-complete"})

proc init*(frameOS: DriverContext): Driver =
  let fbDriver = frameBuffer.init(frameOS)
  var screenInfo = frameBuffer.ScreenInfo(
    width: PanelWidth,
    height: PanelHeight,
    bitsPerPixel: 32,
    redOffset: 16,
    redLength: 8,
    greenOffset: 8,
    greenLength: 8,
    blueOffset: 0,
    blueLength: 8,
    alphaOffset: 24,
    alphaLength: 8,
  )
  var logger = frameOS.logger
  if not fbDriver.isNil:
    screenInfo = fbDriver.screenInfo
    logger = fbDriver.logger
  else:
    frameOS.frameConfig.width = PanelWidth
    frameOS.frameConfig.height = PanelHeight
  result = Driver(
    name: "inkyHyperPixel2r",
    screenInfo: screenInfo,
    logger: logger,
    mode: frameOS.frameConfig.mode,
    gpioHandle: cint(-1),
    panelInitialized: false,
  )
  try:
    result.initializePanel()
  except Exception as e:
    result.log(%*{
      "event": "driver:inkyHyperPixel2r",
      "error": "Failed to initialize native HyperPixel 2.1R panel",
      "exception": e.msg,
      "stack": e.getStackTrace(),
    })

proc setup*(frameOS: DriverContext = nil): SetupResult =
  discard frameOS
  result = setupBootConfig(HyperPixelBootConfigLines)

proc render*(self: Driver, image: Image) =
  if not self.panelInitialized:
    try:
      self.initializePanel()
    except Exception as e:
      self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Panel init failed before render", "exception": e.msg})
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  try:
    self.ensureGpio()
    self.sendCommand(0x11'u8)
    delayMs(120)
    self.sendCommand(0x29'u8)
    delayMs(20)
    self.writePin(GpioBacklight, LG_HIGH)
    self.panelInitialized = true
  except Exception as e:
    self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Failed to turn display on", "exception": e.msg})

proc turnOff*(self: Driver) =
  try:
    self.ensureGpio()
    self.sendCommand(0x28'u8)
    delayMs(20)
    self.sendCommand(0x10'u8)
    self.writePin(GpioBacklight, LG_LOW)
    self.panelInitialized = false
  except Exception as e:
    self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Failed to turn display off", "exception": e.msg})

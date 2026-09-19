import json, pixie, strformat

import lib/lgpio
import lib/gpiomem
import frameos/driver_context
import frameos/device_setup

import drivers/frameBuffer/frameBuffer as frameBuffer
import ./panel

## The Pimoroni HyperPixel 2.1" Round, driven one of two ways (DisplayPath in
## drivers/hyperPixel4/panel), picked by the board:
##
## Pi 0-4: firmware DPI carries the pixels into /dev/fb0 (setup writes the
## dpi_* block into config.txt), and this driver sends the ST7701 its init
## table over a bit-banged 3-wire bus and owns the backlight. Touch is the
## kernel's edt-ft5x06 on an I2C bus setup enables with a small overlay —
## over the same two pins as the init bus, which is why MOSI and the clock
## below are special.
##
## Pi 5: the firmware cannot drive DPI at all, so setup enables the kernel's
## vc4-kms-dpi-hyperpixel2r overlay, which inits the panel and owns the
## backlight. This driver then touches no GPIO: it writes the fb0 KMS
## emulates, and powers the panel by blanking it. No touch there: the
## kernel's init bus holds the touch bus's pins.

const
  GpioClk = 11
  GpioMosi = 10
  GpioCs = 18
  GpioBacklight = 19
  BitDelaySeconds = 0.00001

type Driver* = ref object of frameBuffer.Driver
  mode*: string
  path: DisplayPath
  gpioHandle: cint
  # GPIO 10 and 11 are the init bus's MOSI and clock AND the touch
  # controller's I2C bus, which the kernel's i2c-gpio holds — so a gpiolib
  # claim on them is refused. They are driven straight through the GPIO
  # registers instead (lib/gpiomem), for the length of a burst, and handed
  # back as inputs, which is what an open-drain bus idles as. The panel only
  # listens while its chip select is low and the touch controller only to
  # its own address, so the two buses share the wires; what they cannot share
  # is a moment — see withBus. nil = no usable /dev/gpiomem: the pins are
  # then ordinary lgpio claims, which works where no touch overlay is loaded.
  gpioMem: GpioMem
  busClaimed: bool
  panelInitialized: bool
  # Set by turnOff, cleared by turnOn. While it holds, render still writes
  # every frame into /dev/fb0 (so turnOn shows the current image, like the
  # framebuffer driver after fb0/blank) but never wakes the panel: the first
  # native driver cleared panelInitialized on turnOff instead, and the next
  # render re-ran the init table, which ends in display-on and backlight high.
  displayOff: bool

proc log(self: Driver; payload: JsonNode) =
  if not self.isNil and not self.logger.isNil and not self.logger.log.isNil:
    self.logger.log(payload)

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

  let gpioChip: cint = 0
  self.gpioHandle = lgGpiochipOpen(gpioChip)
  if self.gpioHandle < 0:
    raise newException(OSError, &"Unable to open gpiochip{gpioChip}: {$lguErrorText(self.gpioHandle)}")

  self.claimOutput(GpioCs, LG_HIGH)
  self.claimOutput(GpioBacklight, LG_HIGH)
  self.gpioMem = openGpioMem()
  self.log(%*{"event": "driver:inkyHyperPixel2r", "gpiochip": gpioChip, "init": "gpio-ready",
    "bus": (if self.gpioMem.isNil: "lgpio" else: "gpiomem")})

proc writeBus(self: Driver; pin: int; level: int) =
  if self.gpioMem.isNil:
    self.writePin(pin, level)
  else:
    self.gpioMem.write(pin, level != LG_LOW)

proc beginBus(self: Driver) =
  self.ensureGpio()
  if self.gpioMem.isNil:
    if not self.busClaimed:
      self.claimOutput(GpioClk, LG_LOW)
      self.claimOutput(GpioMosi, LG_LOW)
      self.busClaimed = true
  else:
    for pin in [GpioClk, GpioMosi]:
      self.gpioMem.write(pin, false)
      self.gpioMem.setOutput(pin, true)

proc endBus(self: Driver) =
  ## Hands GPIO 10/11 back as inputs: the I2C bus is the kernel's again.
  if not self.gpioMem.isNil:
    for pin in [GpioClk, GpioMosi]:
      self.gpioMem.setOutput(pin, false)
  elif self.busClaimed:
    discard lgGpioFree(self.gpioHandle, GpioClk.cint)
    discard lgGpioFree(self.gpioHandle, GpioMosi.cint)
    self.busClaimed = false

template withBus(self: Driver; body: untyped) =
  ## A burst and an I2C transfer at the same moment would garble both, and
  ## nothing arbitrates: the kernel only talks to the touch controller when a
  ## finger makes it interrupt, so the window is a touch during the ~0.5 s of
  ## an init or a display power change. The next init puts the panel right.
  self.beginBus()
  try:
    body
  finally:
    self.endBus()

proc writeSpiWord(self: Driver; value: int) =
  var data = value and 0x1ff
  for _ in 0 ..< 9:
    self.writeBus(GpioMosi, if (data and 0x100) != 0: LG_HIGH else: LG_LOW)
    data = (data shl 1) and 0x1ff
    delaySeconds(BitDelaySeconds)
    self.writeBus(GpioClk, LG_HIGH)
    delaySeconds(BitDelaySeconds)
    self.writeBus(GpioClk, LG_LOW)
  self.writeBus(GpioMosi, LG_LOW)

proc sendCommand(self: Driver; command: uint8; data: openArray[uint8] = []) =
  ## Call inside withBus.
  self.writePin(GpioCs, LG_LOW)
  self.writeSpiWord(command.int)
  for value in data:
    self.writeSpiWord(0x100 or value.int)
  self.writePin(GpioCs, LG_HIGH)

proc sendInitTable(self: Driver) =
  ## Call inside withBus.
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

proc initializePanel(self: Driver) =
  # Under KMS the kernel's panel driver already did this, on pins it holds.
  if self.panelInitialized or self.path == dpKms:
    return

  self.log(%*{"event": "driver:inkyHyperPixel2r", "init": "panel-start"})
  self.withBus:
    self.sendInitTable()
  self.writePin(GpioBacklight, LG_HIGH)
  self.panelInitialized = true
  self.log(%*{"event": "driver:inkyHyperPixel2r", "init": "panel-complete"})

proc init*(frameOS: DriverContext): Driver =
  let fbDriver = frameBuffer.init(frameOS)
  if not fbDriver.available:
    # /dev/fb0 did not answer yet; render re-probes. Until then the panel's
    # own geometry beats whatever the config happened to hold.
    frameOS.frameConfig.width = PanelWidth
    frameOS.frameConfig.height = PanelHeight
  result = Driver(
    name: "inkyHyperPixel2r",
    screenInfo: fbDriver.screenInfo,
    logger: fbDriver.logger,
    available: fbDriver.available,
    lastProbeError: fbDriver.lastProbeError,
    probeRetrySeconds: fbDriver.probeRetrySeconds,
    mode: frameOS.frameConfig.mode,
    path: detectDisplayPath(),
    gpioHandle: cint(-1),
    panelInitialized: false,
  )
  result.log(%*{"event": "driver:inkyHyperPixel2r",
    "path": (if result.path == dpKms: "kms" else: "firmware-dpi")})
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
  setupPanel()

proc render*(self: Driver, image: Image) =
  if self.path == dpFirmware and not self.panelInitialized and not self.displayOff:
    try:
      self.initializePanel()
    except Exception as e:
      self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Panel init failed before render", "exception": e.msg})
  frameBuffer.render(self, image)

proc setKmsPower(self: Driver; on: bool) =
  # Blanking the emulated fb0 is a DPMS off: the kernel's panel driver sends
  # display-off and drops the backlight, and the way back re-inits the panel.
  # Writes into fb0 while it is blanked do not wake it.
  let status = frameBuffer.runPrivilegedDisplayShell(
    "echo " & (if on: "0" else: "1") & " > /sys/class/graphics/fb0/blank")
  if status != 0:
    self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Failed to blank/unblank fb0", "on": on})

proc turnOn*(self: Driver) =
  self.displayOff = false
  if self.path == dpKms:
    self.setKmsPower(true)
    return
  try:
    if not self.panelInitialized:
      # Never came up (init failed at boot): the sleep-out below would wake
      # an unconfigured ST7701. Run the whole table instead.
      self.initializePanel()
      return
    self.withBus:
      self.sendCommand(0x11'u8)
      delayMs(120)
      self.sendCommand(0x29'u8)
      delayMs(20)
    self.writePin(GpioBacklight, LG_HIGH)
  except Exception as e:
    self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Failed to turn display on", "exception": e.msg})

proc turnOff*(self: Driver) =
  self.displayOff = true
  if self.path == dpKms:
    self.setKmsPower(false)
    return
  try:
    self.withBus:
      self.sendCommand(0x28'u8)
      delayMs(20)
      self.sendCommand(0x10'u8)
    self.writePin(GpioBacklight, LG_LOW)
    # panelInitialized stays true: sleep-in keeps the ST7701's registers, so
    # turnOn only needs sleep-out + display-on, and render must not re-init.
  except Exception as e:
    self.log(%*{"event": "driver:inkyHyperPixel2r", "error": "Failed to turn display off", "exception": e.msg})

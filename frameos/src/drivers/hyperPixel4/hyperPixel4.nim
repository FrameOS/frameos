import json, pixie, strformat

import lib/lgpio
import lib/gpiomem
import frameos/driver_context
import frameos/device_setup

import drivers/frameBuffer/frameBuffer as frameBuffer
import ./panel

## The Pimoroni HyperPixel 4.0 and 4.0 Square, with or without touch, driven
## one of two ways (panel.DisplayPath), picked by the board:
##
## Pi 0-4, the same split as the 2.1" Round (inkyHyperPixel2r): firmware DPI
## carries the pixels into /dev/fb0 (setup writes the dpi_* block into
## config.txt), and this driver sends the ILI9806E its init stream over a
## bit-banged 3-wire bus and owns the backlight. No Pimoroni or KMS overlay,
## vendor tree or Python. Touch is the kernel's own driver (Goodix on the 4.0,
## FT5x06 on the Square), loaded by a small overlay setup installs. It is
## also why the clock pin below is special.
##
## Pi 5: the firmware cannot drive DPI at all, so setup enables the kernel's
## vc4-kms-dpi-hyperpixel4* overlay, which inits the panel, owns the
## backlight and brings touch up. This driver then touches no GPIO: it writes
## the fb0 KMS emulates, and powers the panel by blanking it.
##
## Either way touch is read through evdev like any other pointer.

const
  GpioClk = 27
  GpioMosi = 26
  GpioCs = 18
  GpioBacklight = 19
  BitDelaySeconds = 0.00001

type Driver* = ref object of frameBuffer.Driver
  mode*: string
  panel: PanelSpec
  path: DisplayPath
  gpioHandle: cint
  # GPIO 27 is the init bus clock AND the touch controller's interrupt line.
  # On a touch board the kernel holds it as an IRQ, and gpiolib refuses to
  # hand an IRQ line out as an output, so the clock is driven the way
  # Pimoroni's own init does it: straight through the GPIO registers
  # (lib/gpiomem), and given back as an input the moment a burst ends.
  # Non-touch boards take the same path so there is one to test. nil = no
  # usable /dev/gpiomem (a kernel without it): the clock is then an ordinary
  # lgpio claim, which works wherever nothing else holds the pin.
  gpioMem: GpioMem
  clkClaimed: bool
  panelInitialized: bool
  # Set by turnOff, cleared by turnOn. While it holds, render still writes
  # every frame into /dev/fb0 (so turnOn shows the current image) but never
  # wakes the panel: the init stream ends in display-on and backlight high.
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
    raise newException(OSError, &"Unable to claim GPIO {pin} for HyperPixel 4: {$lguErrorText(res)}")

proc ensureGpio(self: Driver) =
  if self.gpioHandle >= 0:
    return

  let gpioChip: cint = 0
  self.gpioHandle = lgGpiochipOpen(gpioChip)
  if self.gpioHandle < 0:
    raise newException(OSError, &"Unable to open gpiochip{gpioChip}: {$lguErrorText(self.gpioHandle)}")

  self.claimOutput(GpioMosi, LG_LOW)
  self.claimOutput(GpioCs, LG_HIGH)
  self.claimOutput(GpioBacklight, LG_HIGH)
  self.gpioMem = openGpioMem()
  self.log(%*{"event": "driver:hyperPixel4", "gpiochip": gpioChip, "init": "gpio-ready",
    "clock": (if self.gpioMem.isNil: "lgpio" else: "gpiomem")})

proc writeClk(self: Driver; level: int) =
  if self.gpioMem.isNil:
    self.writePin(GpioClk, level)
  else:
    self.gpioMem.write(GpioClk, level != LG_LOW)

proc beginBus(self: Driver) =
  self.ensureGpio()
  if self.gpioMem.isNil:
    if not self.clkClaimed:
      self.claimOutput(GpioClk, LG_LOW)
      self.clkClaimed = true
  else:
    self.writeClk(LG_LOW)
    self.gpioMem.setOutput(GpioClk, true)

proc endBus(self: Driver) =
  ## Hands GPIO 27 back as an input: the touch controller drives it from here.
  if not self.gpioMem.isNil:
    self.gpioMem.setOutput(GpioClk, false)
  elif self.clkClaimed:
    discard lgGpioFree(self.gpioHandle, GpioClk.cint)
    self.clkClaimed = false

template withBus(self: Driver; body: untyped) =
  self.beginBus()
  try:
    body
  finally:
    self.endBus()

proc writeWord(self: Driver; word: int) =
  ## 9 bits, MSB first, latched on the rising clock edge.
  var data = word and 0x1ff
  for _ in 0 ..< 9:
    self.writePin(GpioMosi, if (data and 0x100) != 0: LG_HIGH else: LG_LOW)
    data = (data shl 1) and 0x1ff
    self.writeClk(LG_LOW)
    delaySeconds(BitDelaySeconds)
    self.writeClk(LG_HIGH)
    delaySeconds(BitDelaySeconds)
  self.writePin(GpioMosi, LG_LOW)

proc sendWords(self: Driver; words: openArray[int]) =
  ## Call inside withBus.
  for frame in initFrames(words):
    if frame[0] == InitWait:
      delayMs(InitWaitMs)
      continue
    self.writePin(GpioCs, LG_LOW)
    for word in frame:
      self.writeWord(word)
    self.writePin(GpioCs, LG_HIGH)

proc initializePanel(self: Driver) =
  # Under KMS the kernel's panel driver already did this, on pins it holds.
  if self.panelInitialized or self.path == dpKms:
    return

  self.log(%*{"event": "driver:hyperPixel4", "init": "panel-start", "panel": $self.panel.kind})
  self.withBus:
    self.sendWords(self.panel.initWords())
  self.writePin(GpioBacklight, LG_HIGH)
  self.panelInitialized = true
  self.log(%*{"event": "driver:hyperPixel4", "init": "panel-complete"})

proc init*(frameOS: DriverContext): Driver =
  let panel = panelForDevice(frameOS.frameConfig.device)
  let fbDriver = frameBuffer.init(frameOS)
  if not fbDriver.available:
    # /dev/fb0 did not answer yet; render re-probes. Until then the panel's
    # own geometry beats whatever the config happened to hold.
    frameOS.frameConfig.width = panel.width
    frameOS.frameConfig.height = panel.height
  result = Driver(
    name: "hyperPixel4",
    screenInfo: fbDriver.screenInfo,
    logger: fbDriver.logger,
    available: fbDriver.available,
    lastProbeError: fbDriver.lastProbeError,
    probeRetrySeconds: fbDriver.probeRetrySeconds,
    mode: frameOS.frameConfig.mode,
    panel: panel,
    path: detectDisplayPath(),
    gpioHandle: cint(-1),
  )
  result.log(%*{"event": "driver:hyperPixel4", "panel": $panel.kind, "touch": panel.touch,
    "path": (if result.path == dpKms: "kms" else: "firmware-dpi")})
  try:
    result.initializePanel()
  except Exception as e:
    result.log(%*{
      "event": "driver:hyperPixel4",
      "error": "Failed to initialize native HyperPixel 4 panel",
      "exception": e.msg,
      "stack": e.getStackTrace(),
    })

proc setup*(frameOS: DriverContext = nil): SetupResult =
  let device = if frameOS.isNil or frameOS.frameConfig.isNil: "" else: frameOS.frameConfig.device
  setupPanel(device)

proc render*(self: Driver, image: Image) =
  if self.path == dpFirmware and not self.panelInitialized and not self.displayOff:
    try:
      self.initializePanel()
    except Exception as e:
      self.log(%*{"event": "driver:hyperPixel4", "error": "Panel init failed before render", "exception": e.msg})
  frameBuffer.render(self, image)

proc setKmsPower(self: Driver; on: bool) =
  # Blanking the emulated fb0 is a DPMS off: the kernel's panel driver sends
  # display-off and drops the backlight, and the way back re-inits the panel.
  # Writes into fb0 while it is blanked do not wake it.
  let status = frameBuffer.runPrivilegedDisplayShell(
    "echo " & (if on: "0" else: "1") & " > /sys/class/graphics/fb0/blank")
  if status != 0:
    self.log(%*{"event": "driver:hyperPixel4", "error": "Failed to blank/unblank fb0", "on": on})

proc turnOn*(self: Driver) =
  self.displayOff = false
  if self.path == dpKms:
    self.setKmsPower(true)
    return
  try:
    if not self.panelInitialized:
      # Never came up (init failed at boot): the sleep-out below would wake
      # an unconfigured ILI9806E. Run the whole stream instead.
      self.initializePanel()
      return
    self.withBus:
      # Sleep out, display on — the tail of the init stream.
      self.sendWords([0x011, 0x100, InitWait, 0x029, 0x100, InitWait])
    self.writePin(GpioBacklight, LG_HIGH)
  except Exception as e:
    self.log(%*{"event": "driver:hyperPixel4", "error": "Failed to turn display on", "exception": e.msg})

proc turnOff*(self: Driver) =
  self.displayOff = true
  if self.path == dpKms:
    self.setKmsPower(false)
    return
  try:
    self.ensureGpio()
    self.writePin(GpioBacklight, LG_LOW)
    self.withBus:
      # Display off, sleep in. Sleep-in keeps the ILI9806E's registers, so
      # panelInitialized stays true and turnOn only needs the way back.
      self.sendWords([0x028, 0x100, InitWait, 0x010, 0x100])
  except Exception as e:
    self.log(%*{"event": "driver:hyperPixel4", "error": "Failed to turn display off", "exception": e.msg})

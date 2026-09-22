import json, pixie

import frameos/driver_context
import frameos/device_setup

import drivers/frameBuffer/frameBuffer as frameBuffer
import ./panel

## The Pimoroni HyperPixel 4.0 and 4.0 Square, with or without touch, on any
## Raspberry Pi: setup enables the kernel's vc4-kms-v3d and
## vc4-kms-dpi-hyperpixel4[sq] overlays (panel.nim), which drive DPI, init
## the panel, own the backlight and bring touch up. This driver touches no
## GPIO: it writes the fb0 KMS emulates, and powers the panel by blanking it.
## Touch is read through evdev like any other pointer.
##
## Pi 0-4 used to take the firmware's DPI instead, with this driver sending
## the panel its init stream over GPIO; that never brought a panel up in the
## field (panel.nim has the story) and is gone.

type Driver* = ref object of frameBuffer.Driver
  mode*: string
  panel: PanelSpec

proc log(self: Driver; payload: JsonNode) =
  if not self.isNil and not self.logger.isNil and not self.logger.log.isNil:
    self.logger.log(payload)

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
  )
  result.log(%*{"event": "driver:hyperPixel4", "panel": $panel.kind, "touch": panel.touch, "path": "kms"})

proc setup*(frameOS: DriverContext = nil): SetupResult =
  let device = if frameOS.isNil or frameOS.frameConfig.isNil: "" else: frameOS.frameConfig.device
  setupPanel(device)

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc setPower(self: Driver; on: bool) =
  # Blanking the emulated fb0 is a DPMS off: the kernel's panel driver sends
  # display-off and drops the backlight, and the way back re-inits the panel.
  # Writes into fb0 while it is blanked do not wake it.
  let status = frameBuffer.runPrivilegedDisplayShell(
    "echo " & (if on: "0" else: "1") & " > /sys/class/graphics/fb0/blank")
  if status != 0:
    self.log(%*{"event": "driver:hyperPixel4", "error": "Failed to blank/unblank fb0", "on": on})

proc turnOn*(self: Driver) =
  self.setPower(true)

proc turnOff*(self: Driver) =
  self.setPower(false)

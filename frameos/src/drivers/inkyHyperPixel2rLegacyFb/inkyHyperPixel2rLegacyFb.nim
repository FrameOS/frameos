import std/strutils
import pixie
import frameos/driver_context
import frameos/device_setup
when defined(linux):
  import lib/lgpio

import drivers/frameBuffer/frameBuffer as frameBuffer

# The HyperPixel 2.1" Round on the kernel's own DPI framebuffer. Rendering is
# the frameBuffer driver's; the one thing this driver adds is the backlight,
# GPIO 19 on the panel's header, which the native inkyHyperPixel2r driver
# drives the same way.
#
# Until 2026-09-07 turnOn/turnOff shelled out to two Python scripts in a
# vendored venv (RPi.GPIO). That needed a `setup` step that built the venv on
# the device — and on a Buildroot image there is no python3 to build it with,
# so setup failed at `cd /srv/frameos/vendor/inkyHyperPixel2r`, the driver never
# initialised, and the panel stayed blank (the Vannituba frame on the HA
# backend's 2026.9.0 image, 2026-09-04). The two scripts were also identical
# (PWM at 0 %, then stop), so "on" and "off" both left the pin low. lgpio does
# it in-process: no vendor tree, no Python, no setup step.

const
  GpioBacklight = 19
  ## The scripts and the native driver both use BCM numbering on the Pi's
  ## main gpiochip (0 on Pi 4 and earlier, 4 on Pi 5).

type Driver* = ref object of frameBuffer.Driver
  mode*: string
  gpioHandle: int

type BacklightHook* = proc(on: bool): int {.nimcall.}

## Test seam: swaps the GPIO write for a recorder. Production leaves it nil.
var backlightHook*: BacklightHook

proc gpioChipFor(): int =
  try:
    if readFile("/proc/cpuinfo").find("Raspberry Pi 5") >= 0:
      return 4
  except CatchableError:
    discard
  0

proc setBacklight(self: Driver, on: bool): int =
  if not backlightHook.isNil:
    return backlightHook(on)
  when defined(linux):
    if self.gpioHandle <= 0:
      self.gpioHandle = lgGpiochipOpen(gpioChipFor().cint).int
      if self.gpioHandle < 0:
        return self.gpioHandle
    # Claim as output at the wanted level; re-claiming a line we already hold
    # returns an error, so fall back to a plain write on that path.
    let level = if on: 1.cint else: 0.cint
    var res = lgGpioClaimOutput(self.gpioHandle.cint, 0, GpioBacklight.cint, level)
    if res < 0:
      res = lgGpioWrite(self.gpioHandle.cint, GpioBacklight.cint, level)
    res.int
  else:
    # The GPIO character device is Linux-only; the driver is built and tested
    # on other hosts through backlightHook.
    discard on
    -1

proc init*(frameOS: DriverContext): Driver =
  let fbDriver = frameBuffer.init(frameOS)
  result = Driver(
    name: "inkyHyperPixel2rLegacyFb",
    screenInfo: fbDriver.screenInfo,
    logger: fbDriver.logger,
    mode: frameOS.frameConfig.mode,
    gpioHandle: 0,
  )

proc setup*(frameOS: DriverContext = nil): SetupResult =
  ## Nothing to install: the framebuffer and the backlight GPIO are the
  ## kernel's, and the display overlay ships with the image.
  discard frameOS
  result = setupOk()

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  discard self.setBacklight(true)

proc turnOff*(self: Driver) =
  discard self.setBacklight(false)

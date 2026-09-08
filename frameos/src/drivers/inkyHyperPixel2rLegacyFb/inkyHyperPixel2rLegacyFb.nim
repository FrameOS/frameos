import std/[os, strutils]
import pixie
import frameos/driver_context
import frameos/device_setup
when defined(linux):
  import std/[posix, volatile]
  import lib/lgpio

import drivers/frameBuffer/frameBuffer as frameBuffer

# The HyperPixel 2.1" Round on the kernel's own DPI output. Rendering is the
# frameBuffer driver's; this driver adds the two things the kernel path needs
# from us: the display overlay in config.txt, and the backlight.
#
# Display overlay. Raspberry Pi OS users historically ran Pimoroni's installer
# (`dtoverlay=hyperpixel2r` plus the dpi_* lines); the kernel has its own
# `vc4-kms-dpi-hyperpixel2r`, and the rpi-firmware Buildroot 2025.02 pins
# ships it. A composed Buildroot image wrote neither, so a frame on this
# device came up with no DPI output at all — that, not the vendor tree, is
# what left Vannituba blank on the HA backend's 2026.9.0 image (2026-09-04).
# `setup` now adds the KMS overlay unless one of the two is already there.
#
# Backlight, GPIO 19. Both overlays hand that pin to the kernel's
# gpio-backlight driver (`rpi_backlight` under Pimoroni's, `backlight` under
# the KMS one), which is why a plain gpiochip claim fails with "GPIO busy" and
# why the vendored Python scripts this driver used until 2026-09-07 went
# through RPi.GPIO: it writes the GPIO registers behind the kernel's back. The
# order here is the kernel's backlight class first (the control that owner
# offers), a gpiochip claim second (a config that only sets `gpio=19=op,dh`
# leaves the line free), and last the register poke RPi.GPIO did, in-process
# and without Python.

const
  GpioBacklight = 19
  ## BCM numbering on the Pi's main gpiochip (0 on Pi 4 and earlier, 4 on Pi 5).
  KmsOverlayLine* = "dtoverlay=vc4-kms-dpi-hyperpixel2r"
  LegacyOverlayLine = "dtoverlay=hyperpixel2r"

type Driver* = ref object of frameBuffer.Driver
  mode*: string
  gpioHandle: int

type BacklightHook* = proc(on: bool): int {.nimcall.}

## Test seam for the GPIO fallbacks (gpiochip claim, register poke); the
## backlight class path is exercised through `backlightClassDir`.
var backlightHook*: BacklightHook

## The kernel backlight class; tests point it at a scratch directory.
var backlightClassDir* = "/sys/class/backlight"

proc hyperPixelBootConfigLines*(currentConfig: string): seq[string] =
  ## The overlay line `setup` adds: none when config.txt already carries a
  ## HyperPixel 2r overlay (Pimoroni's legacy one or the kernel's), else the
  ## kernel's.
  for raw in currentConfig.splitLines():
    let line = raw.strip()
    if line.startsWith(KmsOverlayLine) or line.startsWith(LegacyOverlayLine):
      return @[]
  @[KmsOverlayLine]

proc gpioChipFor(): int =
  try:
    if readFile("/proc/cpuinfo").find("Raspberry Pi 5") >= 0:
      return 4
  except CatchableError:
    discard
  0

proc setBacklightClass(on: bool): int =
  ## /sys/class/backlight/*/bl_power: 0 = on, 4 = FB_BLANK_POWERDOWN. A plain
  ## write first (root frames; the unprivileged Buildroot service gets the
  ## file handed over by its ExecStartPre), then the privileged form.
  var found = false
  var ok = false
  try:
    for kind, path in walkDir(backlightClassDir):
      let blPower = path / "bl_power"
      if not fileExists(blPower):
        continue
      found = true
      let value = if on: "0" else: "4"
      try:
        writeFile(blPower, value)
        ok = true
      except CatchableError:
        if runPrivilegedDisplayShell("echo " & value & " > " & blPower) == 0:
          ok = true
  except CatchableError:
    discard
  if not found: -2 elif ok: 0 else: -1

when defined(linux):
  proc setBacklightGpioChip(self: Driver, on: bool): int =
    if self.gpioHandle <= 0:
      self.gpioHandle = lgGpiochipOpen(gpioChipFor().cint).int
      if self.gpioHandle < 0:
        return self.gpioHandle
    let level = if on: 1.cint else: 0.cint
    var res = lgGpioClaimOutput(self.gpioHandle.cint, 0, GpioBacklight.cint, level)
    if res < 0:
      # Re-claiming a line we already hold fails; a plain write covers that.
      res = lgGpioWrite(self.gpioHandle.cint, GpioBacklight.cint, level)
    res.int

  proc setBacklightRegister(on: bool): int =
    ## What RPi.GPIO did: /dev/gpiomem maps the BCM283x GPIO block at offset 0
    ## on Pi 0–4 (the Pi 5's RP1 is laid out differently and is left alone).
    ## GPFSEL1 is word 1 (pins 10–19, three bits each), GPSET0 word 7,
    ## GPCLR0 word 10.
    if gpioChipFor() == 4:
      return -1
    let fd = posix.open("/dev/gpiomem", O_RDWR or O_SYNC)
    if fd < 0:
      return -1
    defer: discard posix.close(fd)
    let mem = mmap(nil, 4096, PROT_READ or PROT_WRITE, MAP_SHARED, fd, 0)
    if mem == MAP_FAILED:
      return -1
    defer: discard munmap(mem, 4096)
    let regs = cast[ptr UncheckedArray[uint32]](mem)
    let shift = 3 * (GpioBacklight - 10)
    var fsel = volatileLoad(addr regs[1])
    fsel = (fsel and not (7'u32 shl shift)) or (1'u32 shl shift)
    volatileStore(addr regs[1], fsel)
    volatileStore(addr regs[if on: 7 else: 10], 1'u32 shl GpioBacklight)
    0

proc setBacklight(self: Driver, on: bool): int =
  result = setBacklightClass(on)
  if result == 0:
    return
  if not backlightHook.isNil:
    return backlightHook(on)
  when defined(linux):
    result = self.setBacklightGpioChip(on)
    if result != 0:
      result = setBacklightRegister(on)
  else:
    # The GPIO paths are Linux-only; other hosts test through backlightHook.
    result = -1

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
  ## The display overlay into config.txt when no HyperPixel overlay is there
  ## yet (a reboot follows); nothing to install otherwise.
  discard frameOS
  let path = detectBootConfigPath()
  let current = if fileExists(path): readFile(path) else: ""
  result = setupBootConfig(hyperPixelBootConfigLines(current), path)

proc render*(self: Driver, image: Image) =
  frameBuffer.render(self, image)

proc turnOn*(self: Driver) =
  discard self.setBacklight(true)

proc turnOff*(self: Driver) =
  discard self.setBacklight(false)

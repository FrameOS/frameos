## What the hyperPixel4 driver knows about its panels, kept free of GPIO so
## it compiles (and is tested) anywhere: which panel a device id means, which
## of the two ways to drive it this board has, the init stream its controller
## is sent, and what setup leaves on the boot partition for it.

import std/strutils

import frameos/device_setup

type
  PanelKind* = enum
    pkRectangular ## HyperPixel 4.0: 480x800, scanned portrait
    pkSquare      ## HyperPixel 4.0 Square: 720x720

  PanelSpec* = object
    kind*: PanelKind
    touch*: bool
    width*, height*: int

  DisplayPath* = enum
    ## Pi 0-4: the firmware scans DPI out into /dev/fb0 and the driver inits
    ## the panel over GPIO itself, as on the 2.1" Round.
    dpFirmware
    ## Pi 5 family (BCM2712): DPI lives in RP1, which the firmware never
    ## drives — `enable_dpi_lcd` does nothing there. Only the kernel's
    ## drm-rp1-dpi can, so its vc4-kms-dpi-hyperpixel4* overlay owns the
    ## whole panel (init, backlight, touch) and the driver just writes the
    ## fb0 that KMS emulates. Bench-verified on a Pi 5, 2026-09-19.
    dpKms

const
  InitWait* = -1 ## in an init stream: pause InitWaitMs before the next word
  InitWaitMs* = 200

  # Touch-only overlays (sources beside the binaries): the stock ones also
  # claim the DPI pins and the backlight, which are the driver's.
  TouchOverlayRectangular* = "frameos-hyperpixel4-touch"
  TouchOverlaySquare* = "frameos-hyperpixel4sq-touch"
  TouchOverlayRectangularDtbo = staticRead("overlays/frameos-hyperpixel4-touch.dtbo")
  TouchOverlaySquareDtbo = staticRead("overlays/frameos-hyperpixel4sq-touch.dtbo")

  DpiTimingsRectangular* = "dpi_timings=480 0 10 16 59 800 0 15 113 15 0 0 0 60 0 32000000 6"
  DpiTimingsSquare* = "dpi_timings=720 0 15 15 15 720 0 10 10 10 0 0 0 60 0 35113500 6"
  # The 2.1" Round's (drivers/inkyHyperPixel2r/panel.nim writes them), so a
  # card that moves between HyperPixels loses them: config.txt lets the last
  # dpi_timings line win, and lines are only appended.
  DpiTimingsRound* = "dpi_timings=480 0 10 16 55 480 0 15 60 15 0 0 0 60 0 19200000 6"
  TouchOverlayRound* = "frameos-hyperpixel2r-touch"
  KmsOverlayLineRound* = "dtoverlay=vc4-kms-dpi-hyperpixel2r"
  DpiOutputFormatRectangular* = "dpi_output_format=0x7f216"
  DpiOutputFormatSquare* = "dpi_output_format=0x7f226"

  # The ILI9806E init streams, as 9-bit words: bit 8 clear is a register,
  # bit 8 set is a parameter for it. Verbatim from Pimoroni's installers
  # (github.com/pimoroni/hyperpixel4: dist/hyperpixel4-init on the pi4 branch,
  # src/hyperpixel4-init.c on square-pi4; the Square's is also the kernel's
  # panel-tdo-y17p table). They differ in display control (0x21), the VGH/VGL
  # clamps (0x43/0x44), VCOM (0x53) and two writes only the 4.0 gets.
  InitWordsRectangular* = [
    0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x101, 0x008, 0x110,
    0x021, 0x10d, 0x030, 0x102, 0x031, 0x100, 0x040, 0x110,
    0x041, 0x155, 0x042, 0x102, 0x043, 0x184, 0x044, 0x184,
    0x050, 0x178, 0x051, 0x178, 0x052, 0x100, 0x053, 0x177,
    0x057, 0x160, 0x060, 0x107, 0x061, 0x100, 0x062, 0x108,
    0x063, 0x100, 0x0a0, 0x100, 0x0a1, 0x107, 0x0a2, 0x10c,
    0x0a3, 0x10b, 0x0a4, 0x103, 0x0a5, 0x107, 0x0a6, 0x106,
    0x0a7, 0x104, 0x0a8, 0x108, 0x0a9, 0x10c, 0x0aa, 0x113,
    0x0ab, 0x106, 0x0ac, 0x10d, 0x0ad, 0x119, 0x0ae, 0x110,
    0x0af, 0x100, 0x0c0, 0x100, 0x0c1, 0x107, 0x0c2, 0x10c,
    0x0c3, 0x10b, 0x0c4, 0x103, 0x0c5, 0x107, 0x0c6, 0x107,
    0x0c7, 0x104, 0x0c8, 0x108, 0x0c9, 0x10c, 0x0ca, 0x113,
    0x0cb, 0x106, 0x0cc, 0x10d, 0x0cd, 0x118, 0x0ce, 0x110,
    0x0cf, 0x100, 0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x106,
    0x000, 0x120, 0x001, 0x10a, 0x002, 0x100, 0x003, 0x100,
    0x004, 0x101, 0x005, 0x101, 0x006, 0x198, 0x007, 0x106,
    0x008, 0x101, 0x009, 0x180, 0x00a, 0x100, 0x00b, 0x100,
    0x00c, 0x101, 0x00d, 0x101, 0x00e, 0x100, 0x00f, 0x100,
    0x010, 0x1f0, 0x011, 0x1f4, 0x012, 0x101, 0x013, 0x100,
    0x014, 0x100, 0x015, 0x1c0, 0x016, 0x108, 0x017, 0x100,
    0x018, 0x100, 0x019, 0x100, 0x01a, 0x100, 0x01b, 0x100,
    0x01c, 0x100, 0x01d, 0x100, 0x020, 0x101, 0x021, 0x123,
    0x022, 0x145, 0x023, 0x167, 0x024, 0x101, 0x025, 0x123,
    0x026, 0x145, 0x027, 0x167, 0x030, 0x111, 0x031, 0x111,
    0x032, 0x100, 0x033, 0x1ee, 0x034, 0x1ff, 0x035, 0x1bb,
    0x036, 0x1aa, 0x037, 0x1dd, 0x038, 0x1cc, 0x039, 0x166,
    0x03a, 0x177, 0x03b, 0x122, 0x03c, 0x122, 0x03d, 0x122,
    0x03e, 0x122, 0x03f, 0x122, 0x040, 0x122, 0x052, 0x110,
    0x053, 0x110, 0x054, 0x113, 0x0ff, 0x1ff, 0x198, 0x106,
    0x104, 0x107, 0x018, 0x11d, 0x017, 0x122, 0x002, 0x177,
    0x026, 0x1b2, 0x0e1, 0x179, 0x0ff, 0x1ff, 0x198, 0x106,
    0x104, 0x100, 0x03a, 0x160, 0x035, 0x100, 0x011, 0x100,
    InitWait, 0x029, 0x100, InitWait
  ]

  InitWordsSquare* = [
    0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x101, 0x008, 0x110,
    0x021, 0x109, 0x030, 0x102, 0x031, 0x100, 0x040, 0x110,
    0x041, 0x155, 0x042, 0x102, 0x043, 0x109, 0x044, 0x107,
    0x050, 0x178, 0x051, 0x178, 0x052, 0x100, 0x053, 0x16d,
    0x060, 0x107, 0x061, 0x100, 0x062, 0x108, 0x063, 0x100,
    0x0a0, 0x100, 0x0a1, 0x107, 0x0a2, 0x10c, 0x0a3, 0x10b,
    0x0a4, 0x103, 0x0a5, 0x107, 0x0a6, 0x106, 0x0a7, 0x104,
    0x0a8, 0x108, 0x0a9, 0x10c, 0x0aa, 0x113, 0x0ab, 0x106,
    0x0ac, 0x10d, 0x0ad, 0x119, 0x0ae, 0x110, 0x0af, 0x100,
    0x0c0, 0x100, 0x0c1, 0x107, 0x0c2, 0x10c, 0x0c3, 0x10b,
    0x0c4, 0x103, 0x0c5, 0x107, 0x0c6, 0x107, 0x0c7, 0x104,
    0x0c8, 0x108, 0x0c9, 0x10c, 0x0ca, 0x113, 0x0cb, 0x106,
    0x0cc, 0x10d, 0x0cd, 0x118, 0x0ce, 0x110, 0x0cf, 0x100,
    0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x106, 0x000, 0x120,
    0x001, 0x10a, 0x002, 0x100, 0x003, 0x100, 0x004, 0x101,
    0x005, 0x101, 0x006, 0x198, 0x007, 0x106, 0x008, 0x101,
    0x009, 0x180, 0x00a, 0x100, 0x00b, 0x100, 0x00c, 0x101,
    0x00d, 0x101, 0x00e, 0x100, 0x00f, 0x100, 0x010, 0x1f0,
    0x011, 0x1f4, 0x012, 0x101, 0x013, 0x100, 0x014, 0x100,
    0x015, 0x1c0, 0x016, 0x108, 0x017, 0x100, 0x018, 0x100,
    0x019, 0x100, 0x01a, 0x100, 0x01b, 0x100, 0x01c, 0x100,
    0x01d, 0x100, 0x020, 0x101, 0x021, 0x123, 0x022, 0x145,
    0x023, 0x167, 0x024, 0x101, 0x025, 0x123, 0x026, 0x145,
    0x027, 0x167, 0x030, 0x111, 0x031, 0x111, 0x032, 0x100,
    0x033, 0x1ee, 0x034, 0x1ff, 0x035, 0x1bb, 0x036, 0x1aa,
    0x037, 0x1dd, 0x038, 0x1cc, 0x039, 0x166, 0x03a, 0x177,
    0x03b, 0x122, 0x03c, 0x122, 0x03d, 0x122, 0x03e, 0x122,
    0x03f, 0x122, 0x040, 0x122, 0x052, 0x110, 0x053, 0x110,
    0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x107, 0x018, 0x11d,
    0x017, 0x122, 0x002, 0x177, 0x026, 0x1b2, 0x0e1, 0x179,
    0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x100, 0x03a, 0x160,
    0x035, 0x100, 0x011, 0x100, InitWait, 0x029, 0x100, InitWait
  ]

proc panelForDevice*(device: string): PanelSpec =
  ## Device ids: pimoroni.hyperpixel4[sq][_touch].
  let touch = device.endsWith("_touch")
  let model = if touch: device[0 ..< device.len - "_touch".len] else: device
  if model == "pimoroni.hyperpixel4sq":
    PanelSpec(kind: pkSquare, touch: touch, width: 720, height: 720)
  else:
    PanelSpec(kind: pkRectangular, touch: touch, width: 480, height: 800)

proc displayPathForCompatible*(compatible: string): DisplayPath =
  ## `compatible` is the device tree root's, e.g. "raspberrypi,5-model-b\0brcm,bcm2712\0".
  if "brcm,bcm2712" in compatible: dpKms else: dpFirmware

proc detectDisplayPath*(): DisplayPath =
  try:
    result = displayPathForCompatible(readFile("/proc/device-tree/compatible"))
  except CatchableError:
    result = dpFirmware

const
  # Every form of the kernel's overlay line this driver writes or ever wrote
  # (the touchscreen-swapped-x-y one only on a bench card, 2026-09-19):
  # whichever is not wanted is removed by name.
  KmsOverlayLines* = [
    "dtoverlay=vc4-kms-dpi-hyperpixel4",
    "dtoverlay=vc4-kms-dpi-hyperpixel4,touchscreen-swapped-x-y",
    "dtoverlay=vc4-kms-dpi-hyperpixel4,disable-touch",
    "dtoverlay=vc4-kms-dpi-hyperpixel4sq",
    "dtoverlay=vc4-kms-dpi-hyperpixel4sq,disable-touch",
  ]

proc kmsOverlayLine*(kind: PanelKind, touch: bool): string =
  ## The kernel's overlay brings the touch controller with it unless told not
  ## to, and its touch orientation is right as it ships. On the 4.0 that looks
  ## wrong on paper — ABS_X runs 0..799 and ABS_Y 0..479 over a 480x800 fb0 —
  ## but the ranges are just labels: evdev scales each axis by its own range,
  ## and X still runs along fb0's x. Bench 2026-09-19: toggling the swap out
  ## put every tap at its transpose. (Test with a point OFF the diagonal; the
  ## corners cannot tell a transpose from the truth.)
  "dtoverlay=vc4-kms-dpi-hyperpixel4" & (if kind == pkSquare: "sq" else: "") &
    (if touch: "" else: ",disable-touch")

proc touchOverlayName*(panel: PanelSpec): string =
  if panel.kind == pkSquare: TouchOverlaySquare else: TouchOverlayRectangular

proc initWords*(panel: PanelSpec): seq[int] =
  if panel.kind == pkSquare: @InitWordsSquare else: @InitWordsRectangular

proc initFrames*(words: openArray[int]): seq[seq[int]] =
  ## Splits an init stream into chip-select frames: a register word and the
  ## parameters that follow it. A wait is a frame of its own, `@[InitWait]`.
  for word in words:
    if word == InitWait:
      result.add(@[InitWait])
    elif (word and 0x100) == 0 or result.len == 0 or result[^1][0] == InitWait:
      result.add(@[word])
    else:
      result[^1].add(word)

const
  # Every line the firmware-DPI path writes that is the same for both panels.
  FirmwareDpiLines* = [
    "enable_dpi_lcd=1",
    "display_default_lcd=1",
    "dpi_group=2",
    "dpi_mode=87",
    "gpio=0-9=a2,np",
    "gpio=12-17=a2,np",
    "gpio=20-25=a2,np",
    "gpio=19=op,dh",
  ]

proc bootConfigLines*(panel: PanelSpec, path: DisplayPath): seq[string] =
  ## A leading `#` removes a line (setupBootConfig). Whatever this panel on
  ## this board does not want is removed by name: Pimoroni's installer
  ## overlays, the other HyperPixels' blocks, and the other display path's —
  ## config.txt lets the last dpi_timings win and setup only ever appends, so
  ## a card that changes panel or board must not keep the old block.
  let square = panel.kind == pkSquare
  let kmsLine = kmsOverlayLine(panel.kind, panel.touch)
  result = @[
    "#dtoverlay=hyperpixel4",
    "#dtoverlay=hyperpixel2r",
    "#" & KmsOverlayLineRound,
    "#dtoverlay=vc4-fkms-v3d",
    "#" & DpiTimingsRound,
    "#dtoverlay=" & TouchOverlayRound,
  ]
  for line in KmsOverlayLines:
    if path == dpFirmware or line != kmsLine:
      result.add("#" & line)
  # The header's I2C and SPI ports sit on DPI pins.
  result.add("dtparam=i2c_arm=off")
  result.add("dtparam=spi=off")

  if path == dpKms:
    for line in FirmwareDpiLines:
      result.add("#" & line)
    result.add("#" & DpiTimingsRectangular)
    result.add("#" & DpiTimingsSquare)
    result.add("#" & DpiOutputFormatRectangular)
    result.add("#" & DpiOutputFormatSquare)
    result.add("#gpio=27=ip,pu")
    result.add("#dtoverlay=" & TouchOverlayRectangular)
    result.add("#dtoverlay=" & TouchOverlaySquare)
    result.add("dtoverlay=vc4-kms-v3d")
    result.add(kmsLine)
    return

  # The KMS display driver claims the DPI pins and GPIO 19 ahead of us.
  result.add("#dtoverlay=vc4-kms-v3d")
  result.add("#" & (if square: DpiTimingsRectangular else: DpiTimingsSquare))
  result.add("#" & (if square: DpiOutputFormatRectangular else: DpiOutputFormatSquare))
  result.add("#dtoverlay=" & (if square: TouchOverlayRectangular else: TouchOverlaySquare))
  for line in FirmwareDpiLines:
    result.add(line)
  result.add(if square: DpiOutputFormatSquare else: DpiOutputFormatRectangular)
  result.add(if square: DpiTimingsSquare else: DpiTimingsRectangular)
  # GPIO 27 is the touch controller's interrupt (and, during init, our clock).
  if panel.touch:
    result.add("gpio=27=ip,pu")
    result.add("dtoverlay=" & panel.touchOverlayName)
  else:
    result.add("#gpio=27=ip,pu")
    result.add("#dtoverlay=" & panel.touchOverlayName)

proc setupPanel*(device: string, path = detectDisplayPath()): SetupResult =
  let panel = panelForDevice(device)
  # The kernel's overlay carries its own touch nodes; ours is for the path
  # where nothing else brings the touch controller up.
  if panel.touch and path == dpFirmware:
    let dtbo = if panel.kind == pkSquare: TouchOverlaySquareDtbo else: TouchOverlayRectangularDtbo
    addSetupResult(result, setupBootOverlay(panel.touchOverlayName, dtbo))
  addSetupResult(result, setupBootConfig(panel.bootConfigLines(path)))

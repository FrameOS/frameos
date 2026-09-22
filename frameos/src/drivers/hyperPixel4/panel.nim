## What the hyperPixel4 driver knows about its panels, kept free of GPIO so
## it compiles (and is tested) anywhere: which panel a device id means and
## what setup leaves on the boot partition for it. On every Pi that is the
## kernel's vc4-kms-dpi-hyperpixel4* overlay, which owns the whole panel.
##
## The 4.0 and the Square used to take a second, firmware path on Pi 0-4:
## config.txt's dpi_* block scanned fb0 out, and the driver bit-banged the
## ILI9806E its init stream over GPIO 18/26/27. On its first real run, a
## Square on two Pi Zero Ws (2026-09-22), the panel never came up — a fixed
## pattern whatever fb0 held — although the words, pins, timings and firmware
## all matched Pimoroni's legacy installer and the kernel's panel-tdo-y17p.
## The kernel's overlay drove the same panel on the same Zero first time. So
## that path is gone; its config.txt lines are only ever removed now, which
## is how a card set up the old way converts. DisplayPath stays for the 2.1"
## Round (drivers/inkyHyperPixel2r), whose firmware path does work.

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
    ## The 2.1" Round on Pi 0-4: the firmware scans DPI out into /dev/fb0 and
    ## its driver inits the panel over GPIO itself. (The 4.0 family no longer
    ## takes this path; see the top of this file.)
    dpFirmware
    ## Pi 5 family (BCM2712): DPI lives in RP1, which the firmware never
    ## drives — `enable_dpi_lcd` does nothing there. Only the kernel's
    ## drm-rp1-dpi can, so its vc4-kms-dpi-hyperpixel* overlay owns the
    ## whole panel (init, backlight, touch) and the driver just writes the
    ## fb0 that KMS emulates. Bench-verified on a Pi 5, 2026-09-19. The 4.0
    ## family takes it on every board (the kernel's vc4 DPI on Pi 0-4).
    dpKms

const
  # Everything below is written only as a removal now (`#` + line): what the
  # old firmware path left in config.txt, and the Round's block, so a card
  # that changes panel or board converts. Touch-only overlays the old path
  # installed into /boot/overlays:
  TouchOverlayRectangular* = "frameos-hyperpixel4-touch"
  TouchOverlaySquare* = "frameos-hyperpixel4sq-touch"

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

const
  # Every firmware-DPI line the same for every panel: the Round writes them,
  # the 4.0 family only removes them (its old path, see the top of the file).
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

proc bootConfigLines*(panel: PanelSpec): seq[string] =
  ## A leading `#` removes a line (setupBootConfig). The kernel's overlay for
  ## this panel, and removed by name everything else a HyperPixel ever wrote:
  ## Pimoroni's installer overlays, the other panels' kernel overlays, the
  ## Round's block and the old firmware-DPI path's — config.txt lets the last
  ## dpi_timings win and setup only ever appends, so a card that changes
  ## panel or board must not keep an old block.
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
    if line != kmsLine:
      result.add("#" & line)
  # The header's I2C and SPI ports sit on DPI pins.
  result.add("dtparam=i2c_arm=off")
  result.add("dtparam=spi=off")
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

proc setupPanel*(device: string): SetupResult =
  setupBootConfig(panelForDevice(device).bootConfigLines())

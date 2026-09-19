## What the inkyHyperPixel2r driver leaves on the boot partition, kept free of
## GPIO so it compiles (and is tested) anywhere. The display paths, and every
## line the other HyperPixels write, are drivers/hyperPixel4/panel's.

import frameos/device_setup
import drivers/hyperPixel4/panel as hyperPixel4

export hyperPixel4.DisplayPath, hyperPixel4.detectDisplayPath

const
  PanelWidth* = 480
  PanelHeight* = 480
  DpiOutputFormatRound = "dpi_output_format=0x7f216"
  TouchOverlayRoundDtbo = staticRead("overlays/frameos-hyperpixel2r-touch.dtbo")

proc bootConfigLines*(path: DisplayPath): seq[string] =
  ## A leading `#` removes a line (setupBootConfig). Removed by name:
  ## Pimoroni's installer overlay, everything the 4.0 and 4.0 Square write,
  ## and the other display path's block — config.txt lets the last
  ## dpi_timings win and setup only ever appends, so a card that changes
  ## panel or board must not keep the old one.
  result = @[
    "#dtoverlay=hyperpixel2r",
    "#dtoverlay=hyperpixel4",
    "#dtoverlay=vc4-fkms-v3d",
    "#" & DpiTimingsRectangular,
    "#" & DpiTimingsSquare,
    "#" & DpiOutputFormatSquare,
    "#dtoverlay=" & TouchOverlayRectangular,
    "#dtoverlay=" & TouchOverlaySquare,
  ]
  for line in KmsOverlayLines:
    result.add("#" & line)
  # The header's I2C and SPI ports sit on DPI pins.
  result.add("dtparam=i2c_arm=off")
  result.add("dtparam=spi=off")

  if path == dpKms:
    # Pi 5: only the kernel can drive DPI, so its overlay owns the panel. It
    # also holds GPIO 10/11 for the init bus, which are the touch bus — the
    # overlay ships touch disabled for that reason, and so is it here.
    for line in FirmwareDpiLines:
      result.add("#" & line)
    result.add("#" & DpiOutputFormatRound)
    result.add("#" & DpiTimingsRound)
    result.add("#gpio=27=ip,pu")
    result.add("#dtoverlay=" & TouchOverlayRound)
    result.add("dtoverlay=vc4-kms-v3d")
    result.add(KmsOverlayLineRound)
    return

  # The KMS display driver and the kernel's overlay claim the DPI pins, the
  # init bus and GPIO 19 ahead of us.
  result.add("#dtoverlay=vc4-kms-v3d")
  result.add("#" & KmsOverlayLineRound)
  for line in FirmwareDpiLines:
    result.add(line)
  result.add(DpiOutputFormatRound)
  result.add(DpiTimingsRound)
  # Touch: the interrupt pulled up, and the overlay that gives the kernel the
  # I2C bus on GPIO 10/11 (see its .dts for how the init bus shares them).
  result.add("gpio=27=ip,pu")
  result.add("dtoverlay=" & TouchOverlayRound)

proc setupPanel*(path = detectDisplayPath()): SetupResult =
  if path == dpFirmware:
    addSetupResult(result, setupBootOverlay(TouchOverlayRound, TouchOverlayRoundDtbo))
  addSetupResult(result, setupBootConfig(bootConfigLines(path)))

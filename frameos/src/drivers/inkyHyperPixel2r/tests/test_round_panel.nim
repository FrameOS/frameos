import std/[os, sequtils, strutils, times]

import frameos/device_setup
import ../panel
import ../../hyperPixel4/panel as hyperPixel4

block test_firmware_path_writes_the_dpi_block_and_enables_touch:
  let lines = bootConfigLines(dpFirmware)
  doAssert DpiTimingsRound in lines
  doAssert "dpi_output_format=0x7f216" in lines
  doAssert "enable_dpi_lcd=1" in lines and "gpio=19=op,dh" in lines
  # Touch: the kernel gets the I2C bus on GPIO 10/11, interrupt pulled up.
  doAssert "dtoverlay=frameos-hyperpixel2r-touch" in lines
  doAssert "gpio=27=ip,pu" in lines
  # Whoever else wants the pins goes.
  doAssert "#dtoverlay=hyperpixel2r" in lines
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel2r" in lines
  doAssert "#dtoverlay=vc4-kms-v3d" in lines
  doAssert "dtparam=i2c_arm=off" in lines and "dtparam=spi=off" in lines

block test_kms_path_is_the_kernel_overlay_without_touch:
  let lines = bootConfigLines(dpKms)
  doAssert "dtoverlay=vc4-kms-v3d" in lines
  doAssert "dtoverlay=vc4-kms-dpi-hyperpixel2r" in lines
  # The kernel's init bus holds the touch bus's pins there.
  doAssert "#dtoverlay=frameos-hyperpixel2r-touch" in lines
  doAssert "#enable_dpi_lcd=1" in lines and "#" & DpiTimingsRound in lines
  doAssert not lines.anyIt(it.startsWith("dpi_") or it.startsWith("gpio=") or it == "enable_dpi_lcd=1")

block test_a_frame_from_before_touch_gains_two_lines_and_nothing_else:
  # What the driver wrote up to 2026.9.19, verbatim from a bench frame.
  let before = """kernel=Image
disable_overscan=1
dtoverlay=miniuart-bt
arm_64bit=1
gpu_mem=32
dtparam=i2c_arm=off
dtparam=spi=off
enable_dpi_lcd=1
display_default_lcd=1
dpi_group=2
dpi_mode=87
dpi_output_format=0x7f216
dpi_timings=480 0 10 16 55 480 0 15 60 15 0 0 0 60 0 19200000 6
gpio=0-9=a2,np
gpio=12-17=a2,np
gpio=20-25=a2,np
gpio=19=op,dh
"""
  let applied = applyBootConfigLines(before, bootConfigLines(dpFirmware))
  doAssert applied.changed
  proc lines(content: string): seq[string] = content.splitLines().filterIt(it.len > 0)
  doAssert lines(applied.content) == lines(before) & @["gpio=27=ip,pu", "dtoverlay=frameos-hyperpixel2r-touch"]
  doAssert not applyBootConfigLines(applied.content, bootConfigLines(dpFirmware)).changed

block test_setup_installs_the_touch_overlay_only_where_the_driver_owns_the_pins:
  let dir = getTempDir() / ("frameos-hyperpixel2r-" & $epochTime().int64)
  createDir(dir)
  let previousBootConfig = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", dir / "config.txt")
  try:
    doAssert setupPanel(dpFirmware).rebootRequired
    let overlay = dir / "overlays" / "frameos-hyperpixel2r-touch.dtbo"
    doAssert readFile(overlay).startsWith("\xd0\x0d\xfe\xed")
    doAssert "edt,edt-ft5406" in readFile(overlay)
    doAssert not setupPanel(dpFirmware).rebootRequired

    removeDir(dir / "overlays")
    doAssert setupPanel(dpKms).rebootRequired
    doAssert not dirExists(dir / "overlays")
    doAssert readFile(dir / "config.txt").splitLines().filterIt(it.startsWith("dtoverlay=")) ==
      @["dtoverlay=vc4-kms-v3d", "dtoverlay=vc4-kms-dpi-hyperpixel2r"]
  finally:
    if previousBootConfig.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previousBootConfig)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    removeDir(dir)

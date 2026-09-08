import std/[os, unittest]

import ../inkyHyperPixel2rLegacyFb

suite "inkyHyperPixel2r legacy framebuffer driver helpers":
  setup:
    backlightHook = nil
    backlightClassDir = getTempDir() / "frameos-hyperpixel-test-" & $getCurrentProcessId()
    removeDir(backlightClassDir)
    createDir(backlightClassDir)

  teardown:
    backlightHook = nil
    removeDir(backlightClassDir)
    backlightClassDir = "/sys/class/backlight"

  test "setup adds the kernel's HyperPixel overlay when config.txt has none":
    # A composed Buildroot image wrote no display overlay for this device, so
    # the panel had no DPI output at all (Vannituba, 2026-09-04).
    check hyperPixelBootConfigLines("dtoverlay=vc4-kms-v3d\n") == @["dtoverlay=vc4-kms-dpi-hyperpixel2r"]
    check hyperPixelBootConfigLines("") == @["dtoverlay=vc4-kms-dpi-hyperpixel2r"]

  test "setup leaves a config that already carries a HyperPixel overlay alone":
    # Pimoroni's installer (Raspberry Pi OS) and the kernel overlay both own
    # the DPI pins and the backlight; a second overlay would fight the first.
    check hyperPixelBootConfigLines("dtoverlay=hyperpixel2r\nenable_dpi_lcd=1\n").len == 0
    check hyperPixelBootConfigLines("  dtoverlay=vc4-kms-dpi-hyperpixel2r,rotate=90\n").len == 0
    # A commented-out line does not count.
    check hyperPixelBootConfigLines("#dtoverlay=hyperpixel2r\n") == @["dtoverlay=vc4-kms-dpi-hyperpixel2r"]

  test "the kernel backlight class is the first backlight path":
    # gpio-backlight owns GPIO 19 under both overlays (a gpiochip claim gets
    # "GPIO busy"), so the class device is the control that owner offers.
    createDir(backlightClassDir / "rpi_backlight")
    writeFile(backlightClassDir / "rpi_backlight" / "bl_power", "0")
    var gpioCalls = 0
    backlightHook = proc(on: bool): int =
      inc gpioCalls
      0

    let driver = Driver()
    driver.turnOff()
    check readFile(backlightClassDir / "rpi_backlight" / "bl_power") == "4"
    driver.turnOn()
    check readFile(backlightClassDir / "rpi_backlight" / "bl_power") == "0"
    check gpioCalls == 0

  test "without a backlight class device the GPIO paths drive the pin in-process":
    # No Python, no vendor tree: the RPi.GPIO scripts are gone.
    var levels: seq[bool] = @[]
    backlightHook = proc(on: bool): int =
      levels.add(on)
      0

    let driver = Driver()
    driver.turnOn()
    driver.turnOff()
    driver.turnOn()

    check levels == @[true, false, true]

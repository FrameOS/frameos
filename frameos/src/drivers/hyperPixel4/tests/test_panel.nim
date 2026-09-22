import std/[os, sequtils, strutils, times]

import frameos/device_setup
import ../panel

import ../../inkyHyperPixel2r/panel as roundPanel

block test_device_ids_pick_the_panel_and_touch:
  let rect = panelForDevice("pimoroni.hyperpixel4")
  doAssert rect.kind == pkRectangular and not rect.touch
  doAssert (rect.width, rect.height) == (480, 800)

  let rectTouch = panelForDevice("pimoroni.hyperpixel4_touch")
  doAssert rectTouch.kind == pkRectangular and rectTouch.touch

  let square = panelForDevice("pimoroni.hyperpixel4sq")
  doAssert square.kind == pkSquare and not square.touch
  doAssert (square.width, square.height) == (720, 720)

  let squareTouch = panelForDevice("pimoroni.hyperpixel4sq_touch")
  doAssert squareTouch.kind == pkSquare and squareTouch.touch

block test_the_display_path_detection_the_round_uses:
  doAssert displayPathForCompatible("raspberrypi,5-model-b\0brcm,bcm2712\0") == dpKms
  doAssert displayPathForCompatible("raspberrypi,model-zero-w\0brcm,bcm2835\0") == dpFirmware
  doAssert displayPathForCompatible("") == dpFirmware

block test_every_board_gets_the_kernel_overlay_and_nothing_of_the_firmware_path:
  let touch = panelForDevice("pimoroni.hyperpixel4_touch").bootConfigLines()
  doAssert "dtoverlay=vc4-kms-v3d" in touch
  # The overlay as it ships: its touch orientation is the right one (bench).
  doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4" in touch
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4,touchscreen-swapped-x-y" in touch
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4,disable-touch" in touch
  doAssert "#enable_dpi_lcd=1" in touch and "#gpio=0-9=a2,np" in touch
  doAssert "#" & DpiTimingsSquare in touch and "#" & DpiTimingsRectangular in touch
  doAssert "#dtoverlay=frameos-hyperpixel4-touch" in touch
  doAssert "#dtoverlay=frameos-hyperpixel4sq-touch" in touch
  doAssert not touch.anyIt(it.startsWith("dpi_") or it.startsWith("gpio=") or it == "enable_dpi_lcd=1")
  # GPIO 2/3 (I2C) and 7-11 (SPI) are DPI pins: the DPI driver fails to take
  # them ("Error applying setting") if either port is on.
  doAssert "dtparam=i2c_arm=off" in touch and "dtparam=spi=off" in touch

  let square = panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines()
  doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4sq" in square
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4" in square

  let plain = panelForDevice("pimoroni.hyperpixel4sq").bootConfigLines()
  doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4sq,disable-touch" in plain
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4sq" in plain

block test_every_hyperpixel_clears_the_other_panels_blocks:
  # A line one panel adds and another does not must be removed by that other,
  # or a card that changes panels boots with two competing DPI blocks.
  var lists = @[roundPanel.bootConfigLines(dpFirmware), roundPanel.bootConfigLines(dpKms)]
  for device in ["pimoroni.hyperpixel4", "pimoroni.hyperpixel4_touch",
      "pimoroni.hyperpixel4sq", "pimoroni.hyperpixel4sq_touch"]:
    lists.add(panelForDevice(device).bootConfigLines())
  for writer in lists:
    for line in writer.filterIt(it.startsWith("dpi_") or it.startsWith("dtoverlay=") or
        it.startsWith("gpio=") or it == "enable_dpi_lcd=1"):
      for other in lists:
        doAssert line in other or ("#" & line) in other, line

block test_a_card_set_up_the_old_firmware_way_converts:
  # What the firmware path left on Cloud-W (a Pi Zero W, 2026-09-22), which
  # showed a fixed stripe pattern until the kernel's overlay replaced it.
  let old = """start_file=start.elf
gpu_mem=32
dtparam=i2c_arm=off
dtparam=spi=off
enable_dpi_lcd=1
display_default_lcd=1
dpi_group=2
dpi_mode=87
gpio=0-9=a2,np
gpio=12-17=a2,np
gpio=20-25=a2,np
gpio=19=op,dh
dpi_output_format=0x7f226
dpi_timings=720 0 15 15 15 720 0 10 10 10 0 0 0 60 0 35113500 6
gpio=27=ip,pu
dtoverlay=frameos-hyperpixel4sq-touch
"""
  let applied = applyBootConfigLines(old, panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines())
  doAssert applied.changed
  let lines = applied.content.splitLines()
  doAssert lines.filterIt(it.startsWith("dtoverlay=")) ==
    @["dtoverlay=vc4-kms-v3d", "dtoverlay=vc4-kms-dpi-hyperpixel4sq"]
  doAssert not lines.anyIt(it.startsWith("dpi_") or it.startsWith("gpio=") or it.startsWith("enable_dpi") or
    it.startsWith("display_default_lcd"))
  doAssert "start_file=start.elf" in lines and "gpu_mem=32" in lines
  doAssert not applyBootConfigLines(applied.content,
    panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines()).changed

block test_switching_between_hyperpixels_leaves_one_display_block:
  var config = "dtoverlay=vc4-kms-v3d\ndtoverlay=vc4-kms-dpi-hyperpixel4\n"
  for device in ["pimoroni.hyperpixel4_touch", "pimoroni.hyperpixel4sq", "pimoroni.hyperpixel4"]:
    config = applyBootConfigLines(config, panelForDevice(device).bootConfigLines()).content
  # To the Round on a Pi 0-4 (firmware DPI) and back to a Square.
  config = applyBootConfigLines(config, roundPanel.bootConfigLines(dpFirmware)).content
  doAssert not config.splitLines().anyIt(it == "dtoverlay=vc4-kms-v3d")
  config = applyBootConfigLines(config, panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines()).content
  let lines = config.splitLines()
  doAssert lines.filterIt(it.startsWith("dtoverlay=")) ==
    @["dtoverlay=vc4-kms-v3d", "dtoverlay=vc4-kms-dpi-hyperpixel4sq"]
  doAssert not lines.anyIt(it.startsWith("dpi_") or it.startsWith("gpio=") or it.startsWith("enable_dpi"))

block test_setup_writes_config_txt_and_no_overlay_files:
  let dir = getTempDir() / ("frameos-hyperpixel4-" & $epochTime().int64)
  createDir(dir)
  let previousBootConfig = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", dir / "config.txt")
  try:
    doAssert setupPanel("pimoroni.hyperpixel4sq_touch").rebootRequired
    doAssert not dirExists(dir / "overlays")
    doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4sq" in readFile(dir / "config.txt").splitLines()
    doAssert not setupPanel("pimoroni.hyperpixel4sq_touch").rebootRequired
    doAssert setupPanel("pimoroni.hyperpixel4").rebootRequired
    doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4,disable-touch" in readFile(dir / "config.txt").splitLines()
  finally:
    if previousBootConfig.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previousBootConfig)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    removeDir(dir)

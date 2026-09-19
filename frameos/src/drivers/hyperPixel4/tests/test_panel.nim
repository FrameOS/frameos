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

block test_init_streams_split_into_register_frames:
  for panel in [panelForDevice("pimoroni.hyperpixel4"), panelForDevice("pimoroni.hyperpixel4sq")]:
    let frames = initFrames(panel.initWords())
    # Page 1 select: the EXTC register and its five parameters in one frame.
    doAssert frames[0] == @[0x0ff, 0x1ff, 0x198, 0x106, 0x104, 0x101]
    for frame in frames:
      if frame[0] == InitWait:
        doAssert frame.len == 1
        continue
      doAssert (frame[0] and 0x100) == 0            # opens with a register…
      doAssert frame[1 .. ^1].allIt((it and 0x100) != 0) # …then only parameters
    # Sleep out, wait, display on, wait — in that order, at the very end.
    doAssert frames[^4 .. ^1] == @[@[0x011, 0x100], @[InitWait], @[0x029, 0x100], @[InitWait]]
    doAssert frames.concat() == panel.initWords()

block test_the_two_panels_differ_where_upstream_says_they_do:
  proc registers(words: openArray[int]): seq[(int, int, int)] =
    ## (page, register, value) for every single-parameter write.
    var page = -1
    for frame in initFrames(words):
      if frame[0] == 0x0ff:
        page = frame[^1] and 0xff
      elif frame.len == 2:
        result.add((page, frame[0], frame[1] and 0xff))

  let rect = registers(InitWordsRectangular)
  let square = registers(InitWordsSquare)
  doAssert rect.filterIt(it notin square) == @[
    (1, 0x21, 0x0d), (1, 0x43, 0x84), (1, 0x44, 0x84), (1, 0x53, 0x77), (1, 0x57, 0x60), (6, 0x54, 0x13)]
  doAssert square.filterIt(it notin rect) == @[
    (1, 0x21, 0x09), (1, 0x43, 0x09), (1, 0x44, 0x07), (1, 0x53, 0x6d)]

block test_only_the_pi_5_family_needs_the_kernel_to_drive_dpi:
  doAssert displayPathForCompatible("raspberrypi,5-model-b\0brcm,bcm2712\0") == dpKms
  doAssert displayPathForCompatible("raspberrypi,5-compute-module\0brcm,bcm2712\0") == dpKms
  doAssert displayPathForCompatible("raspberrypi,4-model-b\0brcm,bcm2711\0") == dpFirmware
  doAssert displayPathForCompatible("raspberrypi,model-zero-2-w\0brcm,bcm2837\0") == dpFirmware
  doAssert displayPathForCompatible("") == dpFirmware

block test_kms_boot_config_is_the_kernel_overlay_and_nothing_of_the_firmware_path:
  let touch = panelForDevice("pimoroni.hyperpixel4_touch").bootConfigLines(dpKms)
  doAssert "dtoverlay=vc4-kms-v3d" in touch
  # The overlay as it ships: its touch orientation is the right one (bench).
  doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4" in touch
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4,touchscreen-swapped-x-y" in touch
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4,disable-touch" in touch
  doAssert "#enable_dpi_lcd=1" in touch and "#gpio=0-9=a2,np" in touch
  doAssert not touch.anyIt(it.startsWith("dpi_") or it.startsWith("gpio=") or it == "enable_dpi_lcd=1")
  # GPIO 2/3 (I2C) and 7-11 (SPI) are DPI pins: drm-rp1-dpi fails to take
  # them ("Error applying setting") if either port is on.
  doAssert "dtparam=i2c_arm=off" in touch and "dtparam=spi=off" in touch

  let plain = panelForDevice("pimoroni.hyperpixel4sq").bootConfigLines(dpKms)
  doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4sq,disable-touch" in plain
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4sq" in plain
  doAssert "#dtoverlay=vc4-kms-dpi-hyperpixel4" in plain

block test_boot_config_carries_the_panel_timings_and_touch_only_when_asked:
  let rect = panelForDevice("pimoroni.hyperpixel4").bootConfigLines(dpFirmware)
  doAssert DpiTimingsRectangular in rect
  doAssert "#" & DpiTimingsSquare in rect
  doAssert "dpi_output_format=0x7f216" in rect
  doAssert "#dtoverlay=frameos-hyperpixel4-touch" in rect
  doAssert not rect.anyIt(it.startsWith("dtoverlay="))

  let squareTouch = panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines(dpFirmware)
  doAssert DpiTimingsSquare in squareTouch
  doAssert "#" & DpiTimingsRectangular in squareTouch
  doAssert "dpi_output_format=0x7f226" in squareTouch
  doAssert "#dpi_output_format=0x7f216" in squareTouch
  doAssert "dtoverlay=frameos-hyperpixel4sq-touch" in squareTouch
  doAssert "#dtoverlay=frameos-hyperpixel4-touch" in squareTouch
  doAssert "gpio=27=ip,pu" in squareTouch

block test_every_hyperpixel_clears_the_other_panels_blocks:
  # A line one panel adds and another does not must be removed by that other,
  # or a card that changes panels boots with two competing DPI blocks.
  var lists = @[roundPanel.bootConfigLines(dpFirmware), roundPanel.bootConfigLines(dpKms)]
  for device in ["pimoroni.hyperpixel4", "pimoroni.hyperpixel4_touch",
      "pimoroni.hyperpixel4sq", "pimoroni.hyperpixel4sq_touch"]:
    for path in [dpFirmware, dpKms]:
      lists.add(panelForDevice(device).bootConfigLines(path))
  for writer in lists:
    for line in writer.filterIt(it.startsWith("dpi_") or it.startsWith("dtoverlay=") or
        it.startsWith("gpio=") or it == "enable_dpi_lcd=1"):
      for other in lists:
        doAssert line in other or ("#" & line) in other, line

block test_switching_panels_leaves_one_dpi_block:
  var config = "dtoverlay=vc4-kms-v3d\ndtoverlay=vc4-kms-dpi-hyperpixel4\n"
  for device in ["pimoroni.hyperpixel4_touch", "pimoroni.hyperpixel4sq", "pimoroni.hyperpixel4"]:
    config = applyBootConfigLines(config, panelForDevice(device).bootConfigLines(dpFirmware)).content
  config = applyBootConfigLines(config, roundPanel.bootConfigLines(dpFirmware)).content
  config = applyBootConfigLines(config, panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines(dpFirmware)).content
  let lines = config.splitLines()
  doAssert lines.filterIt(it.startsWith("dpi_timings=")) == @[DpiTimingsSquare]
  doAssert lines.filterIt(it.startsWith("dpi_output_format=")) == @["dpi_output_format=0x7f226"]
  doAssert lines.filterIt(it.startsWith("dtoverlay=")) == @["dtoverlay=frameos-hyperpixel4sq-touch"]

block test_a_card_that_moves_to_a_pi_5_and_back_keeps_one_display_path:
  let panel = panelForDevice("pimoroni.hyperpixel4_touch")
  var config = applyBootConfigLines("disable_overscan=1\n", panel.bootConfigLines(dpFirmware)).content
  config = applyBootConfigLines(config, panel.bootConfigLines(dpKms)).content
  var lines = config.splitLines()
  doAssert lines.filterIt(it.startsWith("dtoverlay=")) ==
    @["dtoverlay=vc4-kms-v3d", "dtoverlay=vc4-kms-dpi-hyperpixel4"]
  doAssert not lines.anyIt(it.startsWith("dpi_") or it.startsWith("gpio=") or it.startsWith("enable_dpi"))

  config = applyBootConfigLines(config, panel.bootConfigLines(dpFirmware)).content
  lines = config.splitLines()
  doAssert lines.filterIt(it.startsWith("dtoverlay=")) == @["dtoverlay=frameos-hyperpixel4-touch"]
  doAssert DpiTimingsRectangular in lines and "enable_dpi_lcd=1" in lines

block test_setup_installs_the_touch_overlay_beside_config_txt:
  let dir = getTempDir() / ("frameos-hyperpixel4-" & $epochTime().int64)
  createDir(dir)
  let previousBootConfig = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", dir / "config.txt")
  try:
    let first = setupPanel("pimoroni.hyperpixel4_touch", dpFirmware)
    doAssert first.rebootRequired
    let overlay = dir / "overlays" / "frameos-hyperpixel4-touch.dtbo"
    doAssert fileExists(overlay)
    # A flattened device tree, and the Goodix one at that.
    doAssert readFile(overlay).startsWith("\xd0\x0d\xfe\xed")
    doAssert "goodix,gt911" in readFile(overlay)
    # Same touch orientation as the kernel's overlay, which a bench proved.
    doAssert "touchscreen-inverted-y" in readFile(overlay)
    doAssert "touchscreen-swapped-x-y" in readFile(overlay)
    doAssert "dtoverlay=frameos-hyperpixel4-touch" in readFile(dir / "config.txt").splitLines()

    doAssert not setupPanel("pimoroni.hyperpixel4_touch", dpFirmware).rebootRequired

    # The non-touch board writes no overlay and unhooks the one that is there.
    doAssert setupPanel("pimoroni.hyperpixel4", dpFirmware).rebootRequired
    doAssert not readFile(dir / "config.txt").splitLines().anyIt(it.startsWith("dtoverlay="))

    discard setupPanel("pimoroni.hyperpixel4sq_touch", dpFirmware)
    doAssert "edt,edt-ft5406" in readFile(dir / "overlays" / "frameos-hyperpixel4sq-touch.dtbo")

    # On a Pi 5 the kernel's overlay brings touch; ours is not installed.
    removeDir(dir / "overlays")
    doAssert setupPanel("pimoroni.hyperpixel4sq_touch", dpKms).rebootRequired
    doAssert not dirExists(dir / "overlays")
    doAssert "dtoverlay=vc4-kms-dpi-hyperpixel4sq" in readFile(dir / "config.txt").splitLines()
  finally:
    if previousBootConfig.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previousBootConfig)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    removeDir(dir)

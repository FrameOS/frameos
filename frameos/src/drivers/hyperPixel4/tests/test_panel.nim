import std/[os, sequtils, strutils, times]

import frameos/device_setup
import ../panel

# Read, not imported: the 2.1" Round's driver pulls in lgpio, which only
# compiles on Linux, and all this test wants from it is its config.txt lines.
const roundDriverSource = staticRead("../../inkyHyperPixel2r/inkyHyperPixel2r.nim")

proc roundBootConfigLines(): seq[string] =
  let list = roundDriverSource.split("HyperPixelBootConfigLines* = @[", 1)[1].split("]", 1)[0]
  for line in list.splitLines():
    let quoted = line.strip().strip(chars = {','})
    if quoted.len > 2 and quoted[0] == '"':
      result.add(quoted[1 .. ^2])

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

block test_boot_config_carries_the_panel_timings_and_touch_only_when_asked:
  let rect = panelForDevice("pimoroni.hyperpixel4").bootConfigLines()
  doAssert DpiTimingsRectangular in rect
  doAssert "#" & DpiTimingsSquare in rect
  doAssert "dpi_output_format=0x7f216" in rect
  doAssert "#dtoverlay=frameos-hyperpixel4-touch" in rect
  doAssert not rect.anyIt(it.startsWith("dtoverlay="))

  let squareTouch = panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines()
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
  doAssert DpiTimingsRound in roundBootConfigLines()
  let lists = @[
    roundBootConfigLines(),
    panelForDevice("pimoroni.hyperpixel4_touch").bootConfigLines(),
    panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines(),
  ]
  for writer in lists:
    for line in writer.filterIt(it.startsWith("dpi_") or it.startsWith("dtoverlay=")):
      for other in lists:
        doAssert line in other or ("#" & line) in other, line

block test_switching_panels_leaves_one_dpi_block:
  var config = "dtoverlay=vc4-kms-v3d\ndtoverlay=vc4-kms-dpi-hyperpixel4\n"
  for device in ["pimoroni.hyperpixel4_touch", "pimoroni.hyperpixel4sq", "pimoroni.hyperpixel4"]:
    config = applyBootConfigLines(config, panelForDevice(device).bootConfigLines()).content
  config = applyBootConfigLines(config, roundBootConfigLines()).content
  config = applyBootConfigLines(config, panelForDevice("pimoroni.hyperpixel4sq_touch").bootConfigLines()).content
  let lines = config.splitLines()
  doAssert lines.filterIt(it.startsWith("dpi_timings=")) == @[DpiTimingsSquare]
  doAssert lines.filterIt(it.startsWith("dpi_output_format=")) == @["dpi_output_format=0x7f226"]
  doAssert lines.filterIt(it.startsWith("dtoverlay=")) == @["dtoverlay=frameos-hyperpixel4sq-touch"]

block test_setup_installs_the_touch_overlay_beside_config_txt:
  let dir = getTempDir() / ("frameos-hyperpixel4-" & $epochTime().int64)
  createDir(dir)
  let previousBootConfig = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", dir / "config.txt")
  try:
    let first = setupPanel("pimoroni.hyperpixel4_touch")
    doAssert first.rebootRequired
    let overlay = dir / "overlays" / "frameos-hyperpixel4-touch.dtbo"
    doAssert fileExists(overlay)
    # A flattened device tree, and the Goodix one at that.
    doAssert readFile(overlay).startsWith("\xd0\x0d\xfe\xed")
    doAssert "goodix,gt911" in readFile(overlay)
    doAssert "dtoverlay=frameos-hyperpixel4-touch" in readFile(dir / "config.txt").splitLines()

    doAssert not setupPanel("pimoroni.hyperpixel4_touch").rebootRequired

    # The non-touch board writes no overlay and unhooks the one that is there.
    doAssert setupPanel("pimoroni.hyperpixel4").rebootRequired
    doAssert not readFile(dir / "config.txt").splitLines().anyIt(it.startsWith("dtoverlay="))

    discard setupPanel("pimoroni.hyperpixel4sq_touch")
    doAssert "edt,edt-ft5406" in readFile(dir / "overlays" / "frameos-hyperpixel4sq-touch.dtbo")
  finally:
    if previousBootConfig.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previousBootConfig)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    removeDir(dir)

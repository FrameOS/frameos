## The part of a panel a person sees and touches. The HyperPixel 2.1" Round
## is a 480x480 square to its driver, but its glass is the circle inside that
## square: nothing drawn in the corners shows and no finger reaches them. What
## the frame draws over a scene by itself (the scene switcher, the loading
## mark) stays `insideRound`, and an edge swipe there starts at the rim
## (input_state.nim `edgeAt`). No ESP32 board is round. And two things a
## panel is that scenes and the built-in scenes ask: whether it is fast (a
## change shows as it is drawn) and whether it is paper (it draws in inks).

import std/[math, strutils]

const RoundInset* = 12
  ## How far in from a round panel's rim what the frame draws by itself stays
  ## (the scene switcher, the scene settings, the keyboard on the screen): its
  ## bezel covers some of the circle, and a finger at the very edge misses the
  ## glass.

proc panelIsRound*(device: string): bool =
  ## Whether only the circle inscribed in the panel shows and takes touches.
  device == "pimoroni.hyperpixel2r"

proc insideRound*(width, height, x, y: int, inset = 0): bool =
  ## Whether pixel (x, y) of a width x height picture lies inside the circle
  ## inscribed in it, at least `inset` pixels in from the rim. The circle is
  ## the same whichever way the picture is turned.
  let diameter = min(width, height) - 2 * inset
  if diameter <= 0:
    return false
  # The pixel's centre against the circle's, in half pixels: integers only.
  let dx = 2 * x + 1 - width
  let dy = 2 * y + 1 - height
  dx * dx + dy * dy <= diameter * diameter

proc chordHalf*(radius, dy: int): int =
  ## Half the width of a circle of `radius` at `dy` from its centre: how far
  ## either way a row there may reach.
  if abs(dy) >= radius: 0 else: int(floor(sqrt(float(radius * radius - dy * dy))))

const
  PanelFormatRgb565* = 9
    ## frameos_display.h's FOS_PIXEL_RGB565: an LCD.
  PanelFormatsGrey* = {1, 4, 8}
    ## frameos_display.h's FOS_PIXEL_1BPP, _2BPP_GRAY and _4BPP_GRAY: the
    ## panels that show no color.

var boardPanelFormat* = 0
  ## A board's panel as frameos_display.h numbers it, where the runtime knows
  ## it: an ESP32's own (embedded_main at init, `fos_display_format`), the
  ## board a control plane draws for (`frameos_wasm_set_frame`'s
  ## `pixelFormat`, docs/server-rendering.md) and a grey board the browser
  ## preview runs as (wasm_main). It answers `app.frame.fast`, `paper` and
  ## `color` in every phase: an event, init() and an async continuation have no
  ## canvas to ask, and an ESP32's RGB565 canvas is an LCD's or a 13.3"
  ## color e-paper's on 8 MB. 0: a Pi says by its device.

proc panelIsPaper*(device: string, rgb565Canvas = false): bool =
  ## Whether the panel draws in inks, as e-paper (and a monochrome OLED)
  ## does: few colors, greys dithered, nothing faint. How it looks: what a
  ## change costs is `panelIsFast`. Any panel that is not an LCD. A board
  ## says by its panel; a Pi by its device. Without either, an ESP32's LCD
  ## canvas is its RGB565 buffer.
  if boardPanelFormat > 0:
    return boardPanelFormat != PanelFormatRgb565
  if rgb565Canvas:
    return false
  when defined(frameosEmbedded):
    true
  else:
    device == "embedded" or device.startsWith("waveshare.") or device.startsWith("inky") or
      device.startsWith("pimoroni.inky")

template panelIsFast*(device: string, rgb565Canvas = false): bool =
  ## Whether a change shows as soon as it is drawn: a press, a finger moving,
  ## an animation. False where each change costs a refresh, so a scene draws
  ## less often and a press shows with what it did. Today every panel that is
  ## not paper; a fast e-paper, once there is one, says true here and stays
  ## paper. The one place the runtime decides it; a template, so it costs no
  ## function of its own in the firmware.
  not panelIsPaper(device, rgb565Canvas)

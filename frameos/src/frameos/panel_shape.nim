## The part of a panel a person sees and touches. The HyperPixel 2.1" Round
## is a 480x480 square to its driver, but its glass is the circle inside that
## square: nothing drawn in the corners shows and no finger reaches them. What
## the frame draws over a scene by itself (the scene switcher, the loading
## mark) stays `insideRound`, and an edge swipe there starts at the rim
## (input_state.nim `edgeAt`). No ESP32 board is round. And whether a panel
## is e-paper, where what the frame draws by itself shows no press.

import std/strutils

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

proc panelIsPaper*(device: string, rgb565Canvas: bool): bool =
  ## Whether a press would cost a refresh to show (e-paper, a monochrome
  ## OLED): any panel that is not an LCD. An ESP32's LCD canvas is its RGB565
  ## buffer and any other is e-paper or an OLED; a Pi says by its device.
  if rgb565Canvas:
    return false
  when defined(frameosEmbedded):
    true
  else:
    device == "embedded" or device.startsWith("waveshare.") or device.startsWith("inky") or
      device.startsWith("pimoroni.inky")

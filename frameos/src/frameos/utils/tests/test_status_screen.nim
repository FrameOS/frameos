import std/[strutils, unittest]
import pixie
import ../status_screen

suite "status screen":
  test "phase 0 and every full cycle are the static brand colours":
    let still = markSquareColorsAt(0.0)
    check still == markSquareColorsAt(-1.0)
    check still == markSquareColorsAt(1.0)
    check still == markSquareColorsAt(2.0)
    check still[0] == "#1c7c66" and still[1] == "#8baa3a" and still[2] == "#c8a247"

  test "a third of a cycle moves every brand colour one square along":
    let shifted = markSquareColorsAt(1.0 / 3.0)
    check shifted[0] == "#8baa3a"
    check shifted[1] == "#c8a247"
    check shifted[2] == "#1c7c66"

  test "between the steps the squares blend, and the phase is quantized":
    let mid = markSquareColorsAt(1.0 / 6.0)
    let still = markSquareColorsAt(0.0)
    for i in 0 ..< 3:
      check mid[i] != still[i]
    # Two timestamps inside one animation step draw the same frame — which is
    # what keeps the rasterized-mark cache bounded.
    check markSquareColorsAt(0.1010) == markSquareColorsAt(0.1020)
    check markSquareColorsAt(0.1010) != markSquareColorsAt(0.1400)

  test "the rasterized mark is cached per frame, not per timestamp":
    let white = color(1, 1, 1, 1)
    let a = frameosMark(40, white, true, 0.1010)
    let b = frameosMark(40, white, true, 0.1020)
    let c = frameosMark(40, white, true, 0.5)
    check a == b
    check a != c
    check frameosMark(40, white, true, 0.0) == frameosMark(40, white, true, -1.0)

  test "text output lists the bar before the footer":
    let screen = StatusScreen(status: "Ready", rows: @[("Name", "uus2w")],
      bar: "Last button: Next (GPIO 5) at 14:32:05", footer: "FrameOS v1", dark: true)
    let text = statusScreenText(screen)
    check text.endsWith("Last button: Next (GPIO 5) at 14:32:05\nFrameOS v1")
    check "Name: uus2w" in text

  test "dark panels get a grey bottom band holding the bar; light panels do not":
    let dark = newImage(400, 240)
    drawStatusScreen(dark, StatusScreen(status: "Ready", rows: @[("Name", "uus2w")],
      bar: "Last button: Next (GPIO 5)", footer: "FrameOS v1", dark: true))
    let bandPixel = dark[2, dark.height - 3]
    check bandPixel.r > 25 and bandPixel.r < 50
    check bandPixel.r == bandPixel.g and bandPixel.g == bandPixel.b
    # White text in the band: the bar is drawn in the foreground colour.
    var brightInBand = 0
    for y in dark.height - 40 ..< dark.height:
      for x in 0 ..< dark.width div 2:
        if dark[x, y].r > 200: inc brightInBand
    check brightInBand > 20

    let light = newImage(400, 240)
    drawStatusScreen(light, StatusScreen(status: "Ready", rows: @[("Name", "uus2w")],
      bar: "Last button: Next (GPIO 5)", footer: "FrameOS v1", dark: false))
    let corner = light[2, light.height - 3]
    check corner.r == 255 and corner.g == 255 and corner.b == 255

  test "an animated dark screen draws coloured squares that change with the phase":
    let a = newImage(400, 240)
    drawStatusScreen(a, StatusScreen(status: "Ready", dark: true, markPhase: 0.2))
    let b = newImage(400, 240)
    drawStatusScreen(b, StatusScreen(status: "Ready", dark: true, markPhase: 0.6))
    var differing = 0
    for y in 0 ..< a.height:
      for x in 0 ..< a.width:
        if a[x, y] != b[x, y]: inc differing
    check differing > 50

import std/[options, strformat, unittest]
import pixie
import pixie/fileformats/svg
import ../driver_render_hint
import ../panel_canvas
import ../utils/svg_frames

# The Linux runner's canvas on a panel that takes RGB565 as it is (a
# HyperPixel 4.0): one canvas for the uptime, bracketed per render the way
# the ESP32 brackets its LCD buffer, so a whole-frame SVG repaints only what
# changed. Shaped after the Touch test: a dark background, two lines of text
# that stay, and a dot that moves.

const
  W = 240
  H = 240

proc touchFrame(x, y: int): string =
  &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">""" &
    &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#202020"/>""" &
    &"""<rect x="12" y="12" width="80" height="14" fill="#ffffff"/>""" &
    &"""<circle cx="{x}" cy="{y}" r="20" fill="#d64545"/>""" &
    "</svg>"

proc render(canvas: Image, doc: string): int =
  ## One render as the runner runs it into the panel canvas; pixels painted.
  var owed = some(color(0, 0, 0, 1))
  beginPanelCanvasFrame(canvas)
  try:
    doAssert renderSvgFrame(doc, canvas, owed, wholeFrame = true)
  finally:
    endPanelCanvasFrame()
  svgFramePixelsForTest

suite "the panel canvas":
  test "only an unturned, unmirrored frame at the panel's own size uses it":
    let panel = (width: 720, height: 720, format: PanelCanvasRgb565)
    check panelCanvasFits(panel, 720, 720, 720, 720, 0, "")
    check panelCanvasFits(panel, 720, 720, 720, 720, 0, "none")
    check not panelCanvasFits(panel, 720, 720, 720, 720, 90, "")
    check not panelCanvasFits(panel, 720, 720, 720, 720, 0, "horizontal")
    check not panelCanvasFits(panel, 720, 720, 360, 360, 0, "") # a scaled render
    check not panelCanvasFits(panel, 800, 480, 800, 480, 0, "") # a config the panel is not
    check not panelCanvasFits((width: 720, height: 720, format: 0), 720, 720, 720, 720, 0, "")

  test "it is made once, kept, and dropped when the panel stops offering it":
    reportPanelCanvas(W, H, PanelCanvasRgb565)
    let first = panelCanvasFor(W, H, W, H, 0, "")
    check not first.isNil
    check first.isRgb565
    check first.ditherStores
    check panelCanvasFor(W, H, W, H, 0, "") == first
    reportPanelCanvas(0, 0, 0)
    check panelCanvasFor(W, H, W, H, 0, "").isNil
    check not first.isPanelCanvas

  test "a dot that moves repaints around the dot, not the panel":
    reportPanelCanvas(W, H, PanelCanvasRgb565)
    let canvas = panelCanvasFor(W, H, W, H, 0, "")
    check render(canvas, touchFrame(60, 60)) == W * H # nothing to compare with yet
    let moved = render(canvas, touchFrame(180, 170))
    check moved > 0
    check moved < W * H div 4
    # What the canvas holds is what a whole render draws.
    let whole = newImage565(W, H)
    whole.ditherStores = true
    parseSvg(touchFrame(180, 170), W, H).renderInto(whole)
    var worst = 0
    for y in 0 ..< H:
      for x in 0 ..< W:
        let (p, q) = (canvas[x, y], whole[x, y])
        worst = max(worst, max(abs(p.r.int - q.r.int), max(abs(p.g.int - q.g.int), abs(p.b.int - q.b.int))))
    check worst <= 9

  test "an overlay drawn into the canvas makes the next frame whole":
    reportPanelCanvas(W, H, PanelCanvasRgb565)
    let canvas = panelCanvasFor(W, H, W, H, 0, "")
    discard render(canvas, touchFrame(30, 30))
    discard render(canvas, touchFrame(40, 30))
    canvas.fill(rgba(255, 255, 255, 255)) # the local access code, say
    notePanelCanvasWritten()
    check render(canvas, touchFrame(50, 30)) == W * H
    check render(canvas, touchFrame(60, 30)) < W * H div 4

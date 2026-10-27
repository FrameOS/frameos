import std/[options, strformat]
import pixie
import pixie/fileformats/svg
import ../svg_frames

# An LCD's two frame buffers, drawn in turn by a scene whose whole frame is
# one SVG: each render repaints only the damage against what that buffer
# held two frames back, and every frame must still come out as a whole
# render would (down to an antialiasing level at a shape's edge, see pixie's
# test_svg_damage.nim). Anything that breaks the premise — a write the
# firmware made into the buffer, a render that is not the whole frame, an SVG
# that does not cover the canvas — draws it whole.

const
  W = 240
  H = 160

proc frame(i: int, cover = true): string =
  let
    x = (i * 9) mod 150
    y = (i * 4) mod 100
    color = ["#55dfff", "#ff72c8", "#b9ed67"][i div 5 mod 3]
    background =
      if cover: &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#090b14"/>"""
      else: ""
  &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">""" &
    background &
    &"""<g transform="translate({x.float + 3:.2f} {y.float + 3:.2f})" opacity="0.32">""" &
    """<path d="M0 0C20 -10 40 -10 60 0L50 30H10Z" fill="#000"/></g>""" &
    &"""<g transform="translate({x.float:.2f} {y.float:.2f})"><path d="M0 0C20 -10 40 -10 60 0L50 30H10Z" fill="{color}"/></g>""" &
    "</svg>"

proc wholeRender(doc: string): Image =
  result = newImage565(W, H)
  result.ditherStores = true
  parseSvg(doc, W, H).renderInto(result)

proc closeTo(a, b: Image): bool =
  for y in 0 ..< H:
    for x in 0 ..< W:
      let (p, q) = (a[x, y], b[x, y])
      if abs(p.r.int - q.r.int) > 9 or abs(p.g.int - q.g.int) > 9 or abs(p.b.int - q.b.int) > 9:
        return false
  true

var
  storage: array[2, seq[uint16]]
  buffers: array[2, Image]
  generations: array[2, uint32]
for i in 0 .. 1:
  storage[i] = newSeq[uint16](W * H)
  buffers[i] = newImage565Over(W, H, addr storage[i][0])
  buffers[i].ditherStores = true
  buffers[i].fill(rgba(255, 0, 255, 255)) # the panel's power-on garbage

proc renderInto(i: int, doc: string, wholeFrame = true): int =
  ## One render into buffer i mod 2, as the ESP32 runs it; the pixels painted.
  let target = buffers[i mod 2]
  beginPanelFrame(target.bufferPointer, generations[i mod 2])
  var owed = some(color(0, 0, 0, 1))
  svgFramePixelsForTest = -1
  doAssert renderSvgFrame(doc, target, owed, wholeFrame)
  endPanelFrame()
  svgFramePixelsForTest

block:
  # The first frame into each buffer is whole; after that only the damage.
  doAssert renderInto(0, frame(0)) == W * H
  doAssert renderInto(1, frame(1)) == W * H
  for i in 2 ..< 30:
    let painted = renderInto(i, frame(i))
    # One box around where the logo was and where it is: when it wraps
    # from the right edge to the left, that box spans both.
    doAssert painted > 0 and painted < W * H div 2, &"frame {i} repainted {painted} pixels"
    doAssert closeTo(buffers[i mod 2], wholeRender(frame(i))), &"frame {i} differs from a whole render"

block:
  # The firmware wrote into buffer 0 (a copy, an overlay): drawn whole.
  generations[0] += 1
  doAssert renderInto(30, frame(30)) == W * H
  doAssert closeTo(buffers[0], wholeRender(frame(30)))
  doAssert renderInto(32, frame(32)) < W * H div 4

block:
  # A render that is not the whole frame: drawn the ordinary way, and the
  # buffer is not remembered — the next frame into it is whole.
  discard renderInto(34, frame(34), wholeFrame = false)
  doAssert closeTo(buffers[0], wholeRender(frame(34)))
  doAssert renderInto(36, frame(36)) == W * H

block:
  # An SVG that leaves pixels uncovered pays the background and is not kept.
  discard renderInto(38, frame(38, cover = false))
  doAssert buffers[0][0, 0] == rgbx(0, 0, 0, 255), $buffers[0][0, 0]
  doAssert renderInto(40, frame(40)) == W * H

block:
  # A render of something else into the buffer (no renderSvgFrame at all)
  # leaves no record behind either.
  beginPanelFrame(buffers[0].bufferPointer, generations[0])
  buffers[0].fill(rgba(255, 255, 255, 255))
  endPanelFrame()
  doAssert renderInto(42, frame(42)) == W * H
  doAssert closeTo(buffers[0], wholeRender(frame(42)))

echo "svg frames ok"

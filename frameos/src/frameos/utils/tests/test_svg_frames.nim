import std/[options, strformat]
import pixie
import pixie/fileformats/svg
import ../svg_frames
import ../font # the typeface resolver the layout's text uses
import ../../ui/layout

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


block:
  # Three buffers in turn (the SenseCAP Indicator's), a panel of six cards
  # whose switches flip one at a time and a count in the corner: a frame
  # repaints boxes around what changed since its buffer's frame (the cards
  # flipped in the last three renders, and the count), never the canvas
  # between them, and still comes out as a whole render.
  proc panel(i: int): string =
    result = &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">""" &
      &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#0f172a"/>"""
    for k in 0 ..< 6:
      let
        on = (i + k) mod 6 == 0
        x = 8 + (k mod 3) * 78
        y = 40 + (k div 3) * 58
      result.add &"""<rect x="{x}" y="{y}" width="70" height="50" rx="10" fill="{(if on: "#fcd34d" else: "#334155")}"/>"""
      result.add &"""<circle cx="{x + (if on: 58 else: 46)}" cy="{y + 12}" r="6" fill="#fff"/>"""
    result.add &"""<rect x="180" y="8" width="{20 + (i mod 5) * 8}" height="14" rx="3" fill="#94a3b8"/>"""
    result.add "</svg>"
  var
    store3: array[3, seq[uint16]]
    three: array[3, Image]
  for b in 0 .. 2:
    store3[b] = newSeq[uint16](W * H)
    three[b] = newImage565Over(W, H, addr store3[b][0])
    three[b].ditherStores = true
  var most = 0
  for i in 0 ..< 18:
    let target = three[i mod 3]
    beginPanelFrame(target.bufferPointer, 0)
    var owed = some(color(0, 0, 0, 1))
    svgFramePixelsForTest = -1
    doAssert renderSvgFrame(panel(i), target, owed, true)
    endPanelFrame()
    if i >= 3:
      most = max(most, svgFramePixelsForTest)
    doAssert closeTo(target, wholeRender(panel(i))), &"frame {i} differs from a whole render"
  # Two cards' boxes and the count's at most (the switch that came on and
  # the one that went off since the buffer's frame): under a quarter.
  doAssert most > 0 and most < W * H div 4, $most

block:
  # A UI laid out with its memo (the nodes that did not change handed back,
  # pixie keeping their parse) through three buffers: every frame still
  # comes out as a whole render of a fresh layout.
  proc el(tag, classes: string, children: varargs[SvgNode]): SvgNode =
    result = SvgNode(tag: tag, attrs: @[("class", classes)])
    for c in children: result.children.add c
  proc ui(i: int): SvgNode =
    # Cards switched on and off, a count whose width changes, now and then
    # a banner that moves everything below it, and a label that reflows.
    result = el("div", "flex flex-col gap-2 p-2 bg-slate-900 text-white")
    if i mod 5 == 3:
      result.children.add el("div", "h-4 rounded bg-red-500")
    result.children.add el("div", "flex justify-between text-xs",
      el("span", "", SvgNode(text: "Home")), el("span", "", SvgNode(text: $(i * 7 mod 13) & " on")))
    let grid = el("div", "flex-1 grid grid-cols-3 gap-2")
    for k in 0 ..< 6:
      let
        on = (i + k) mod 4 == 0
        label = if k == 4 and i mod 3 == 1: "A longer card name" else: "Card " & $k
      grid.children.add el("div", if on: "flex flex-col justify-between p-1 rounded-lg bg-amber-300 text-black" else: "flex flex-col justify-between p-1 rounded-lg bg-slate-700",
        el("span", "text-xs font-bold", SvgNode(text: label)), el("div", "w-3 h-3 rounded-full bg-white"))
    result.children.add grid
  var
    store: array[3, seq[uint16]]
    bufs: array[3, Image]
    memo = UiMemo()
  # New buffers can sit where the last block's were: nothing is known of them.
  forgetPanelFrames()
  for b in 0 .. 2:
    store[b] = newSeq[uint16](W * H)
    bufs[b] = newImage565Over(W, H, addr store[b][0])
    bufs[b].ditherStores = true
  for i in 0 ..< 24:
    var regions: seq[UiRegion]
    let
      target = bufs[i mod 3]
      root = layoutUi(ui(i), W, H, UiInput(), regions, memo)
    beginPanelFrame(target.bufferPointer, 0)
    var owed = some(color(0, 0, 0, 1))
    doAssert renderSvgFrame(root, target, owed, true, reuse = true)
    endPanelFrame()
    let expected = newImage565(W, H)
    expected.ditherStores = true
    parseSvg(layoutUi(ui(i), W, H), W, H).renderInto(expected)
    doAssert closeTo(target, expected), &"UI frame {i} differs from a whole render"

block:
  # A scene comes up on three buffers that hold another scene's frames, and
  # is tapped twice: the firmware's write generation of every buffer known
  # (panelBufferGeneration), each tap's buffer starts from the newest frame
  # another one still holds, copied in, and repaints the tap's damage only.
  # A buffer written since its frame was left (an overlay) is passed over
  # for an older one.
  proc cards(i: int): string =
    result = &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">""" &
      &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#0f172a"/>"""
    for k in 0 ..< 6:
      let
        on = k < i
        x = 8 + (k mod 3) * 78
        y = 40 + (k div 3) * 58
      result.add &"""<rect x="{x}" y="{y}" width="70" height="50" rx="10" fill="{(if on: "#fcd34d" else: "#334155")}"/>"""
    result.add "</svg>"
  var
    store: array[3, seq[uint16]]
    bufs: array[3, Image]
    gens: array[3, uint32]
  forgetPanelFrames()
  for b in 0 .. 2:
    store[b] = newSeq[uint16](W * H)
    bufs[b] = newImage565Over(W, H, addr store[b][0])
    bufs[b].ditherStores = true
  proc generationOf(buffer: pointer): int64 {.nimcall, raises: [].} =
    for b in 0 .. 2:
      if bufs[b].bufferPointer == buffer:
        return gens[b].int64
    -1
  panelBufferGeneration = generationOf
  proc into(b: int, doc: string): int =
    beginPanelFrame(bufs[b].bufferPointer, gens[b])
    var owed = some(color(0, 0, 0, 1))
    svgFramePixelsForTest = -1
    doAssert renderSvgFrame(doc, bufs[b], owed, true)
    endPanelFrame()
    doAssert closeTo(bufs[b], wholeRender(doc)), &"buffer {b} differs from a whole render"
    svgFramePixelsForTest
  for b in 0 .. 2:
    discard into(b, frame(b))      # the scene before, in every buffer
  doAssert into(0, cards(0)) == W * H # the new scene's first frame: whole
  doAssert into(1, cards(1)) < W * H div 8 # a tap: buffer 0's frame, and one card
  doAssert into(2, cards(2)) < W * H div 8 # a tap: buffer 1's frame, and one card
  # Again, but the firmware writes over the newest frame (an overlay on
  # buffer 1) before the second tap: buffer 0's frame is the one copied in.
  forgetPanelFrames()
  for b in 0 .. 2:
    discard into(b, frame(10 + b))
  discard into(0, cards(0))
  discard into(1, cards(1))
  gens[1] += 1
  bufs[1].view(0, 0, 40, 20).fill(rgba(255, 0, 255, 255))
  doAssert into(2, cards(2)) < W * H div 4 # two cards; no magenta corner
  panelBufferGeneration = nil

echo "svg frames ok"

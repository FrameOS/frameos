import std/[options, strformat]
import pixie
import pixie/fileformats/svg
import ../svg_frames
from ../image import svgRoot
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
    var
      regions: seq[UiRegion]
      input: UiInput
    let
      target = bufs[i mod 3]
      root = layoutUi(ui(i), W, H, input, regions, memo)
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

  # A buffer whose own frame is another scene's, while another buffer holds
  # this one's (going back to a scene): that frame is
  # copied in, and the one the buffer held is let go. It was kept instead,
  # its whole parse with it, at every such switch: a SenseCAP Indicator ran
  # out of room for its JSX UIs' interpreters after a few dozen switches,
  # and their buttons stopped answering (2026-11-07).
  forgetPanelFrames()
  proc goingBack() =
    discard into(0, frame(20))
    discard into(1, cards(3))
    doAssert into(0, cards(3)) == 0 # buffer 1's frame, copied in: nothing to paint
  for _ in 0 ..< 20:
    goingBack()
  let before = getOccupiedMem()
  for _ in 0 ..< 200:
    goingBack()
  let grown = getOccupiedMem() - before
  doAssert grown < 64 * 1024, &"{grown} bytes kept over 200 switches back"
  panelBufferGeneration = nil

echo "svg frames ok"

block a_ui_laid_out_larger_than_the_panel:
  # A UI at render scale 0.5 (render_scale.nim) is laid out twice the canvas's
  # size and drawn into it: the root's width and height are the layout's, the
  # target the panel. A change on the right half of the layout is damage on
  # the right half of the panel, repainted there.
  proc scaled(i: int): string =
    let x = W + 20 + (i mod 4) * 40 # always past the panel's own width, in layout pixels
    &"""<svg width="{2 * W}" height="{2 * H}"><rect x="0" y="0" width="{2 * W}" height="{2 * H}" fill="#090b14"/>""" &
      &"""<rect x="{x}" y="40" width="50" height="50" fill="#55dfff"/></svg>"""
  proc whole(doc: string): Image =
    result = newImage565(W, H)
    result.ditherStores = true
    parseSvg(doc, W, H).renderInto(result)
  for i in 0 ..< 8:
    discard renderInto(100 + i, scaled(i))
    doAssert closeTo(buffers[(100 + i) mod 2], whole(scaled(i))), &"scaled frame {i} differs from a whole render"

block a_scaled_ui_with_a_box_that_clips:
  # The same at 0.5 with what a page's box that clips makes (ui/layout.nim):
  # its children in a nested <svg> viewport. The right half of the layout,
  # inside it, repaints on the right half of the panel.
  proc clipped(i: int): string =
    let w = 40 + (i mod 6) * 70 # a bar growing across the layout's whole width
    &"""<svg width="{2 * W}" height="{2 * H}"><rect x="0" y="0" width="{2 * W}" height="{2 * H}" fill="#090b14"/>""" &
      &"""<svg x="0" y="0" width="{2 * W}" height="{2 * H}" viewBox="0 0 {2 * W} {2 * H}">""" &
      &"""<rect x="10" y="40" width="{w}" height="30" fill="#55dfff"/></svg></svg>"""
  proc whole(doc: string): Image =
    result = newImage565(W, H)
    result.ditherStores = true
    parseSvg(doc, W, H).renderInto(result)
  for i in 0 ..< 12:
    discard renderInto(200 + i, clipped(i))
    doAssert closeTo(buffers[(200 + i) mod 2], whole(clipped(i))), &"clipped frame {i} differs from a whole render"

block a_rectangle_of_the_panel:
  # A scene drawn into a rectangle of the buffer (a layout's hole, a split's
  # panel) repaints its own damage there and touches nothing around it.
  const
    TopH = 20
    RegionH = H - TopH
  proc scene(i: int): string =
    let x = (i * 9) mod 150
    &"""<svg width="{W}" height="{RegionH}"><rect x="0" y="0" width="{W}" height="{RegionH}" fill="#090b14"/>""" &
      &"""<rect x="{x}" y="30" width="40" height="30" fill="#55dfff"/></svg>"""
  proc whole(doc: string): Image =
    result = newImage565(W, RegionH)
    result.ditherStores = true
    parseSvg(doc, W, RegionH).renderInto(result)
  proc sameAsWhole(view: Image, doc: string): bool =
    let want = whole(doc)
    for y in 0 ..< RegionH:
      for x in 0 ..< W:
        let (p, q) = (view[x, y], want[x, y])
        if abs(p.r.int - q.r.int) > 9 or abs(p.g.int - q.g.int) > 9 or abs(p.b.int - q.b.int) > 9:
          return false
    true
  var
    store: array[2, seq[uint16]]
    bufs: array[2, Image]
    gens: array[2, uint32]
  forgetPanelFrames()
  for b in 0 .. 1:
    store[b] = newSeq[uint16](W * H)
    bufs[b] = newImage565Over(W, H, addr store[b][0])
    bufs[b].fill(rgba(255, 0, 255, 255))
  proc generationOf(buffer: pointer): int64 {.nimcall, raises: [].} =
    for b in 0 .. 1:
      if bufs[b].bufferPointer == buffer:
        return gens[b].int64
    -1
  panelBufferGeneration = generationOf
  proc into(b: int, doc: string, take = true): int =
    beginPanelFrame(bufs[b].bufferPointer, gens[b])
    let view = bufs[b].view(0, TopH, W, RegionH)
    if take:
      takePanelRegion(view)
    var owed = some(color(0, 0, 0, 1))
    svgFramePixelsForTest = -1
    doAssert renderSvgFrame(doc, view, owed, true)
    endPanelFrame()
    doAssert sameAsWhole(view, doc), "the rectangle differs from a whole render"
    doAssert bufs[b][5, 5] == rgbx(255, 0, 255, 255), "the render reached outside its rectangle"
    svgFramePixelsForTest
  let region = W * RegionH
  doAssert into(0, scene(0)) == region
  doAssert into(0, scene(1)) < region div 4         # its own damage
  # Nothing to compare against without the record the host takes off the shelf.
  doAssert into(0, scene(2), take = false) == region
  # The other buffer has none of its own: this one's frame, copied in, and the damage.
  doAssert into(1, scene(3)) < region div 4
  # Pixels that came from somewhere else: no record, drawn whole.
  beginPanelFrame(bufs[0].bufferPointer, gens[0])
  takePanelRegion(bufs[0].view(0, TopH, W, RegionH))
  endPanelFrame()
  gens[1] += 1 # and nothing to copy from either
  doAssert into(0, scene(4)) == region
  doAssert into(0, scene(5)) < region div 4
  # Gone with the scene that drew them; a whole frame's record is another matter.
  forgetPanelRegions()
  doAssert into(0, scene(6)) == region
  panelBufferGeneration = nil

block around_several_holes:
  # What is left of the canvas: every pixel once, none in a hole.
  proc check(holes: openArray[PixelBox]) =
    var seen: array[100 * 100, int]
    for box in aroundHoles(100, 100, holes):
      for y in box.y ..< box.y + box.h:
        for x in box.x ..< box.x + box.w:
          inc seen[y * 100 + x]
    for y in 0 ..< 100:
      for x in 0 ..< 100:
        var inHole = 0
        for h in holes:
          if x >= h.x and x < h.x + h.w and y >= h.y and y < h.y + h.h: inc inHole
        doAssert seen[y * 100 + x] == 1 - inHole, $(x, y, seen[y * 100 + x])
  check([])
  check([(x: 0, y: 0, w: 100, h: 100)])
  check([(x: 0, y: 10, w: 40, h: 80), (x: 60, y: 10, w: 40, h: 80)])
  check([(x: 10, y: 0, w: 30, h: 30), (x: 50, y: 20, w: 30, h: 50), (x: 5, y: 60, w: 20, h: 40)])

block the_chrome_around_a_hole:
  const
    HX = 30
    HY = 20
    HW = 150
    HH = 100
  let target = newImage565(W, H)
  target.fill(rgba(255, 0, 255, 255))
  let page = svgRoot(&"""<svg width="{W}" height="{H}"><rect x="10" y="10" width="{W - 20}" height="{H - 20}" fill="#ffffff"/></svg>""")
  var owed = some(color(0, 0, 0, 1))
  doAssert renderSvgAround(page, target, [(x: HX, y: HY, w: HW, h: HH)], owed)
  doAssert owed.isNone
  doAssert target[2, 2] == rgbx(0, 0, 0, 255), "the background owed around the hole"
  doAssert target[15, 15] == rgbx(255, 255, 255, 255)
  doAssert target[HX + HW + 5, HY + 5] == rgbx(255, 255, 255, 255), "the side of the hole"
  doAssert target[15, HY + HH + 5] == rgbx(255, 255, 255, 255), "below the hole"
  for (x, y) in [(HX, HY), (HX + HW - 1, HY), (HX, HY + HH - 1), (HX + HW - 1, HY + HH - 1), (HX + 40, HY + 40)]:
    doAssert target[x, y] == rgbx(255, 0, 255, 255), "inside the hole"

  # A hole in a corner leaves no empty strips to draw.
  let corner = newImage565(W, H)
  var nothingOwed = none(Color)
  doAssert renderSvgAround(page, corner, [(x: 0, y: 0, w: W, h: 30)], nothingOwed)
  doAssert corner[20, 40] == rgbx(255, 255, 255, 255)

echo "svg frames in rectangles ok"


block a_moving_logo_through_three_buffers:
  # DVD Logo Bounce (the store scene) on a SenseCAP Indicator: a logo of three
  # paths and its shadow, the same paths, moving at whole-millisecond
  # fractions of a pixel each frame, through the LCD's three buffers with the
  # device's coverage budget. pixie draws a moving path at the nearest
  # quarter pixel (paths.nim snapMoving) to blend it from kept masks, up to
  # 1/8 px from where damageRects measures it: the pixel of margin its
  # paintBounds already gives every element takes that in, so no buffer
  # gathers a trail of faint edge columns left outside the box that should
  # have taken them away. Every frame comes out as a whole render, and after
  # warming up the logo's fills come from its masks: the six fills were
  # 19.8 ms of a 63 ms frame, each rasterized afresh at a new fraction
  # (2026-11-15).
  const
    LW = 480
    LH = 450
    DvdPaths = [
    "M108.605 58.081c1.766-2.129 11.285-13.399 11.285-13.399h35.936c18.197 0 30.922 9.53 28.012 21.776-2.906 12.247-20.248 21.778-38.359 21.778h-24.09l7.227-30.422H145.6l-4.949 20.833h3.812c10.139 0 19.738-3.697 21.756-12.189 1.854-7.798-4.873-12.188-15.791-12.188h-3.984l-16.529.014-39.02 44.041-15.324-43.274s-.112-.276-.254-.649c-.035-.089-.328-.397-.485-.338-.286.106-.24.603-.19.711.125.266.162.367.196.497 1.368 3.34 1.446 8.946.89 11.187-3.031 12.218-20.25 21.778-38.359 21.778h-24.09l7.228-30.422H37.49l-4.949 20.833h3.812c10.138 0 19.682-3.697 21.699-12.189 1.852-7.798-4.817-12.188-15.734-12.188h-3.985l-16.983-.008 2.277-9.58H46.13l29.846-.039v.039h12.289s3.469 10.161 4.545 13.236c5.149 14.707 4.297 15.702 4.297 15.702s-.619-.949 11.498-15.54z",
    "M8.504 110.273c0-6.496 37.163-11.762 83.001-11.762 45.841 0 83.001 5.266 83.001 11.762 0 6.498-37.16 11.764-83.001 11.764-45.838 0-83.001-5.266-83.001-11.764zm79.997 4.153c10.47 0 18.954-1.754 18.954-3.922 0-2.164-8.484-3.92-18.954-3.92-10.467 0-18.952 1.756-18.952 3.92 0 2.168 8.485 3.922 18.952 3.922z",
    "M36.536 142.711h.062l5.119-10.32h4.816l-8.93 15.722h-2.622l-8.777-15.722h4.816l5.516 10.32zM61.983 147.707h-4.481v-15.316h4.481v15.316zM74.993 132.391h6.399c6.645 0 11.095 3.311 11.095 7.678 0 4.307-4.573 7.639-11.125 7.639h-6.37v-15.317h.001zm4.479 12.714h.731c5.517 0 7.651-2.031 7.651-5.059 0-3.33-2.562-5.057-7.651-5.057h-.731v10.116zM108.914 134.99v3.371h7.131v2.604h-7.131v4.14h7.406v2.602h-11.886v-15.316h11.886v2.599h-7.406zM127.955 140.027c0-4.287 4.662-8.045 11.367-8.045 6.703 0 11.369 3.758 11.369 8.045 0 4.387-4.666 8.086-11.369 8.086-6.705 0-11.367-3.699-11.367-8.086zm4.633-.119c0 2.312 2.926 5.26 6.734 5.26s6.734-2.947 6.734-5.26c0-2.479-2.803-4.979-6.734-4.979-3.933.001-6.734 2.501-6.734 4.979z",
    ]
  proc mark(fill: string): string =
    result = &"""<g fill="{fill}" fill-rule="evenodd">"""
    for d in DvdPaths:
      result.add &"""<path d="{d}"/>"""
    result.add "</g>"
  proc place(left, top, scale: float): string =
    &"translate({left - 8 * scale:.2f} {top - 44 * scale:.2f}) scale({scale:.5f})"
  proc logoFrame(i: int): string =
    let
      logoW = LW * 0.2
      scale = logoW / 176
      offsetY = (logoW * 0.62 - 104 * scale) / 2
      shadow = LH.float * 0.009
      x = 40.0 + i.float * 5.737
      y = 60.0 + i.float * 4.191
    &"""<svg xmlns="http://www.w3.org/2000/svg" width="{LW}" height="{LH}" viewBox="0 0 {LW} {LH}">""" &
      &"""<rect x="0" y="0" width="{LW}" height="{LH}" fill="#090b14"/>""" &
      &"""<g transform="{place(x + shadow, y + offsetY + shadow, scale)}" opacity="0.32">{mark("#000000")}</g>""" &
      &"""<g transform="{place(x, y + offsetY, scale)}">{mark("#55dfff")}</g>""" &
      # A bar on its own, its straight sides the edges of its damage box: a
      # sliver of coverage along a whole side if a box missed it, where a
      # curve's extremum leaves next to none.
      &"""<g transform="translate({20 + i.float * 3.371:.2f} {300 + i.float * 1.113:.2f})">""" &
      """<path d="M0 0.3H40.6V10H0Z" fill="#ffffff"/></g>""" &
      "</svg>"
  proc differs(a, b: Image): int =
    ## Pixels further apart than a dithered store and a mask's rounding go.
    for y in 0 ..< LH:
      for x in 0 ..< LW:
        let (p, q) = (a[x, y], b[x, y])
        if abs(p.r.int - q.r.int) > 9 or abs(p.g.int - q.g.int) > 9 or abs(p.b.int - q.b.int) > 9:
          inc result

  forgetPanelFrames()
  coverageCacheBudget = 256 * 1024 # embedded_main.nim's
  clearCoverageCache()
  var
    store: array[3, seq[uint16]]
    lcd: array[3, Image]
  for i in 0 .. 2:
    store[i] = newSeq[uint16](LW * LH)
    lcd[i] = newImage565Over(LW, LH, addr store[i][0])
    lcd[i].ditherStores = true
  var hits, misses, repainted: int
  for i in 0 ..< 60:
    let target = lcd[i mod 3]
    beginPanelFrame(target.bufferPointer, 0)
    var owed = some(color(0, 0, 0, 1))
    let (hits0, misses0) = (coverageCacheHits, coverageCacheMisses)
    svgFramePixelsForTest = -1
    doAssert renderSvgFrame(logoFrame(i), target, owed, wholeFrame = true)
    endPanelFrame()
    if i >= 3:
      doAssert svgFramePixelsForTest < LW * LH div 10, &"frame {i} repainted {svgFramePixelsForTest} pixels"
    if i >= 40:
      hits += coverageCacheHits - hits0
      misses += coverageCacheMisses - misses0
      repainted += svgFramePixelsForTest
    let whole = newImage565(LW, LH)
    whole.ditherStores = true
    parseSvg(logoFrame(i), LW, LH).renderInto(whole)
    let off = differs(target, whole)
    doAssert off == 0, &"frame {i}: {off} pixels differ from a whole render (a trail)"
  # Seven fills a frame, twenty frames: blended from masks but for a
  # few made along the way, and a fill a damage box shows too little of.
  doAssert hits >= 120, &"the logo is drawn from its masks: {hits} hits, {misses} misses in 20 frames"
  doAssert coverageCacheUsedBytes() <= 256 * 1024
  coverageCacheBudget = 0
  clearCoverageCache()
  forgetPanelFrames()
  echo &"a moving logo ok: {repainted div 20} pixels, {hits} mask hits, {misses} misses in 20 frames"

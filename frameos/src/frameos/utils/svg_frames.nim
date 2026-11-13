## Repainting only what changed, for a scene whose whole frame is one SVG.
##
## An LCD's canvas is the panel's own back frame buffer (embedded_runtime
## `panelCanvas`), and with its buffers drawn in turn (three on the SenseCAP
## Indicator) each one holds a frame from a few renders back. When a render
## draws nothing but one SVG straight into that
## buffer — the scene's render is a single fused node (ExecutionContext's
## `wholeFrame`) and the SVG begins with an opaque full-canvas rect — and
## nothing else has written into the buffer since (the firmware's write
## generation for it), the buffer holds exactly that SVG's render. The next
## render into it then repaints the boxes pixie's `damageRects` finds between
## the two SVGs, each drawing only the elements over it, and leaves the rest
## as it is: for DVD Logo Bounce on the SenseCAP Indicator, a box around the
## logo instead of 230,400 pixels; for a JSX home panel whose switch was
## flipped, that card and the count it changed, not the canvas between them.
##
## The record is taken off the shelf when a render into the buffer begins
## and put back only by a render that drew the buffer whole this way, so a
## render of anything else, a failed one or a write the firmware made leaves
## no record behind.
##
## A buffer with no record of its own (the first renders after a scene came
## up, two of the SenseCAP's three buffers) starts from the newest other
## buffer that still holds its record's frame, by that buffer's own write
## generation (`panelBufferGeneration`): its pixels are copied in, ~25 ms
## for a 480x480 RGB565 buffer, and only the damage against that frame is
## drawn. A tap right after a scene comes up costs what any other tap does.
##
## A scene drawn into a rectangle of the panel's buffer (a layout's hole, a
## split's panel) keeps a record of its own, for that rectangle. Taken off the
## shelf when the scene is about to draw there (`takePanelRegion`); a rectangle
## whose pixels came from elsewhere takes its record off the same way, and
## every record goes when the buffers stop showing what they were showing
## (`forgetPanelFrames`, called on a scene switch and when something draws over
## the canvas).
##
## A `frameos.pixels` frame (js_runtime/app_runtime.nim) keeps a record of the
## same kind per buffer, the cells and palette it wrote (`PixelFrame`): off the
## shelf when a render begins, back only after a pixel frame, so the next one
## into that buffer writes only the cells whose index or color differs.

import std/options
import pixie
import pixie/fileformats/svg
import frameos/utils/canvas_log
import frameos/utils/image
import frameos/utils/memory
import frameos/render_probe

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

const
  MaxRepaints = 6
    ## Boxes a frame repaints at most (pixie's damageRects joins the rest):
    ## each costs a look at every element's bounds, and those over it.
  MaxHeldFrames = 6
    ## Records kept (a parse is 16-45 KB of PSRAM on an ESP32): three frame
    ## buffers, each with a whole frame or a hole's picture and a bar's.

type HeldFrame = object
  buffer: pointer
  generation: uint32
  isRegion: bool ## a rectangle of the buffer (a view), not the whole of it
  origin, width, height: int
  svg: Svg
  canvases: seq[tuple[image: Image, version: int]]
    ## the version of each canvas the frame showed (utils/canvas_log.nim)

var
  heldFrames: seq[HeldFrame] ## oldest first
  panelBuffer: pointer
  panelGeneration: uint32
  panelHeld: Option[HeldFrame]
  regionHeld: Option[HeldFrame]
  panelBufferGeneration*: proc(buffer: pointer): int64 {.nimcall, raises: [].}
    ## The firmware's write generation of any of the panel's buffers, -1 for
    ## one it does not know (embedded_runtime: fos_display_buffer_generation).
    ## Unset, a buffer without its own record is drawn whole.

type
  PixelPalette* = array[256, ColorRGBX]
    ## An 8-bit palette frame's colors, every index a cell can hold.
  PixelFrame* = object
    ## What a `frameos.pixels` frame left in a panel buffer: its cells and
    ## their colors, so the next frame into that buffer writes only the cells
    ## whose index or color differs.
    buffer: pointer
    generation: uint32
    width*, height*, size*: int
    palette*: PixelPalette
    cells*: seq[uint8]

const MaxHeldPixelFrames = 4
  ## An LCD has three buffers; a panel change forgets them all anyway.

var
  heldPixelFrames: seq[PixelFrame]
  panelPixelFrame: PixelFrame
  panelHasPixelFrame: bool

when defined(testing):
  var svgFramePixelsForTest* = 0
    ## Pixels the last renderSvgFrame repainted (test_svg_frames.nim).

  proc heldPixelFrameBytesForTest*(): int =
    ## The memory the kept pixel frames hold (test_hellfire_scene.nim).
    for frame in heldPixelFrames:
      result += frame.cells.capacity

proc beginPanelFrame*(buffer: pointer, generation: uint32) =
  ## A render into the panel buffer `buffer` begins; `generation` counts the
  ## writes the firmware made into it (anything but a render in place).
  panelBuffer = buffer
  panelGeneration = generation
  panelHeld = none(HeldFrame)
  for i in 0 ..< heldFrames.len:
    if heldFrames[i].buffer == buffer and not heldFrames[i].isRegion:
      panelHeld = some(heldFrames[i])
      heldFrames.delete(i)
      break
  # Off the list like the SVG above: whatever draws this render, only a pixel
  # frame puts it back, so a settings panel or another scene in between means
  # the next pixel frame writes every cell.
  panelHasPixelFrame = false
  for i in 0 ..< heldPixelFrames.len:
    if heldPixelFrames[i].buffer == buffer:
      panelPixelFrame = move heldPixelFrames[i]
      panelHasPixelFrame = true
      heldPixelFrames.delete(i)
      break

proc endPanelFrame*() =
  panelBuffer = nil
  panelHeld = none(HeldFrame)
  regionHeld = none(HeldFrame)
  panelHasPixelFrame = false
  panelPixelFrame = PixelFrame()

proc regionRecord(view: Image): int =
  ## This rectangle's record for the panel's current buffer, -1 for none.
  for i in 0 ..< heldFrames.len:
    template frame: untyped = heldFrames[i]
    if frame.buffer == panelBuffer and frame.isRegion and frame.origin == view.origin and
        frame.width == view.width and frame.height == view.height:
      return i
  -1

proc takePanelRegion*(view: Image) =
  ## A scene is about to draw into this rectangle, or its pixels are about to
  ## come from another buffer: its record leaves the shelf, and only a render
  ## that draws the rectangle whole puts one back.
  regionHeld = none(HeldFrame)
  if panelBuffer.isNil or view.isNil or view.bufferPointer != panelBuffer or not view.isView:
    return
  let i = view.regionRecord
  if i >= 0:
    regionHeld = some(heldFrames[i])
    heldFrames.delete(i)

proc takePanelPixelFrame*(target: Image, wholeFrame: bool): tuple[panel: bool, frame: PixelFrame] =
  ## For a frame of cells going into `target`: `panel` when it is the buffer
  ## this render began on and nothing else draws in it, and then the cells it
  ## holds, if the firmware has not written into it since (else `frame` is
  ## empty and every cell gets written).
  if panelBuffer.isNil or target.isNil or target.isView or not wholeFrame or
      target.bufferPointer != panelBuffer:
    return
  result.panel = true
  if panelHasPixelFrame and panelPixelFrame.generation == panelGeneration:
    result.frame = move panelPixelFrame
  panelHasPixelFrame = false

proc keepPanelPixelFrame*(frame: sink PixelFrame) =
  ## What the panel buffer of this render holds now.
  if panelBuffer.isNil:
    return
  heldPixelFrames.add frame
  heldPixelFrames[^1].buffer = panelBuffer
  heldPixelFrames[^1].generation = panelGeneration
  if heldPixelFrames.len > MaxHeldPixelFrames:
    heldPixelFrames.delete(0)

proc area(rects: seq[tuple[x, y, w, h: int]]): int =
  for r in rects:
    result += r.w * r.h

proc newestHeldFrame(target: Image): int =
  ## The newest record of another buffer that still holds its frame (its
  ## write generation unchanged since), of the target's size; -1 for none.
  if panelBufferGeneration.isNil:
    return -1
  for i in countdown(heldFrames.high, 0):
    let frame = heldFrames[i]
    if frame.buffer != panelBuffer and frame.width == target.width and
        frame.height == target.height and frame.isRegion == target.isView and
        (not target.isView or frame.origin == target.origin) and
        panelBufferGeneration(frame.buffer) == frame.generation.int64:
      return i
  -1

proc copyFrameIn(target: Image, source: pointer) =
  ## What `source` (another of the panel's buffers) holds where `target` is.
  if target.format == pfGray4:
    let raw = cast[ptr UncheckedArray[uint8]](source)
    for y in 0 ..< target.height:
      let index = target.dataIndex(0, y)
      copyGray4Levels(target.data8, index, raw, index, target.width)
    return
  let
    bpp = target.bytesPerPixel
    d = cast[ptr UncheckedArray[byte]](target.bufferPointer)
    s = cast[ptr UncheckedArray[byte]](source)
  for y in 0 ..< target.height:
    let offset = target.dataIndex(0, y) * bpp
    copyMem(d[offset].addr, s[offset].addr, target.width * bpp)

proc canvasesShown(svg: Svg): seq[tuple[image: Image, version: int]] =
  for p in svg.pictures:
    let log = canvasLogOf(p.image)
    if not log.isNil:
      result.add((p.image, log.version))

proc pictureArea(p: SvgPicture, box: Rect, target: Image): tuple[x, y, w, h: int] =
  ## `box`, in the picture's own pixels, where the frame draws it: through
  ## the box the picture is stretched into, its clip and its transform, and a
  ## pixel around for the samples a scaled picture blends.
  let
    sx = p.box.w / p.image.width.float32
    sy = p.box.h / p.image.height.float32
  var
    x0 = p.box.x + box.x * sx
    y0 = p.box.y + box.y * sy
    x1 = p.box.x + (box.x + box.w) * sx
    y1 = p.box.y + (box.y + box.h) * sy
  if p.clip.w >= 0:
    x0 = max(x0, p.clip.x)
    y0 = max(y0, p.clip.y)
    x1 = min(x1, p.clip.x + p.clip.w)
    y1 = min(y1, p.clip.y + p.clip.h)
  if x1 <= x0 or y1 <= y0:
    return (0, 0, 0, 0)
  var lo = vec2(float32.high, float32.high)
  var hi = vec2(float32.low, float32.low)
  for corner in [vec2(x0, y0), vec2(x1, y0), vec2(x0, y1), vec2(x1, y1)]:
    let c = p.transform * corner
    lo = vec2(min(lo.x, c.x), min(lo.y, c.y))
    hi = vec2(max(hi.x, c.x), max(hi.y, c.y))
  let
    px0 = clamp(floor(lo.x).int - 1, 0, target.width)
    py0 = clamp(floor(lo.y).int - 1, 0, target.height)
    px1 = clamp(ceil(hi.x).int + 1, 0, target.width)
    py1 = clamp(ceil(hi.y).int + 1, 0, target.height)
  (px0, py0, px1 - px0, py1 - py0)

proc canvasRects(base: HeldFrame, parsed: Svg, target: Image): seq[tuple[x, y, w, h: int]] =
  ## What changed in the canvases `parsed` shows since `base` showed them,
  ## where the frame draws it. A canvas `base` did not show is a new element
  ## to damageRects already; one drawn into more often than its log keeps
  ## repaints whole.
  for p in parsed.pictures:
    let log = canvasLogOf(p.image)
    if log.isNil:
      continue
    var shown = -1
    for (image, version) in base.canvases:
      if image == p.image:
        shown = version
    if shown < 0 or shown == log.version:
      continue
    let (known, boxes) = log.changedSince(shown)
    let areas = if known: boxes else: @[rect(0, 0, p.image.width.float32, p.image.height.float32)]
    for area in areas:
      let r = pictureArea(p, area, target)
      if r.w > 0 and r.h > 0:
        result.add r

proc forgetPanelFrames*() =
  ## Nothing a buffer held is known any more (a panel or size change).
  heldFrames.setLen(0)
  heldPixelFrames.setLen(0)
  endPanelFrame()

proc forgetPanelRegions*() =
  ## What the rectangles of the panel's buffers held is not known any more (a
  ## scene switch, a hole that moved, something drawn over the canvas). Whole
  ## frames' records go too: the next frame is drawn whole anyway. The frame
  ## being drawn is left alone.
  heldFrames.setLen(0)
  regionHeld = none(HeldFrame)

type PixelBox* = tuple[x, y, w, h: int]

proc aroundHoles*(width, height: int, holes: openArray[PixelBox]): seq[PixelBox] =
  ## A rectangle less `holes`, which do not overlap, as boxes: a band for each
  ## run of rows where the same holes are, cut at their sides.
  var top = 0
  while top < height:
    var bottom = height
    for h in holes:
      if h.y > top and h.y < bottom: bottom = h.y
      if h.y + h.h > top and h.y + h.h < bottom: bottom = h.y + h.h
    var x = 0
    while true:
      var next = -1
      for i in 0 ..< holes.len:
        if holes[i].w > 0 and holes[i].y <= top and holes[i].y + holes[i].h >= bottom and holes[i].x >= x and
            (next < 0 or holes[i].x < holes[next].x):
          next = i
      if next < 0:
        break
      if holes[next].x > x:
        result.add((x, top, holes[next].x - x, bottom - top))
      x = holes[next].x + holes[next].w
    if x < width:
      result.add((x, top, width - x, bottom - top))
    top = bottom

proc renderSvgAround*(root: SvgNode, target: Image, holes: openArray[PixelBox], owed: var Option[Color],
    reuse = false): bool =
  ## A UI's chrome: `root` drawn everywhere on `target` but its holes, whose
  ## pixels are the embedded scenes' (docs/scene-layouts.md). The scene
  ## background still owed is settled the same way, around them.
  ##
  ## No damage boxes: the chrome is a strip of the panel, drawn when it is due,
  ## and most of what a damage record would save is its own parse.
  if root.isNil or target.isNil:
    return false
  refreshDecodeBudgetInto(forDecode = false)
  try:
    var parsed: Svg
    probe(phParse):
      parsed = parseSvg(root, target.width, target.height, reuse)
    let pay = owed.isSome and not parsed.coversOpaque(target.width, target.height)
    probe(phRaster):
      for r in aroundHoles(target.width, target.height, holes):
        if r.w > 0 and r.h > 0:
          let window = target.view(r.x, r.y, r.w, r.h)
          if pay:
            payBackground(window, owed.get())
          parsed.renderInto(window, r.x, r.y)
    owed = none(Color)
    result = true
  except CatchableError:
    result = false

proc renderSvgFrame*(root: SvgNode, target: Image, owed: var Option[Color], wholeFrame: bool,
    reuse = false): bool =
  ## renderSvgIntoTarget, repainting only the damage when `target` is the
  ## panel buffer this render began on (beginPanelFrame), the render draws
  ## nothing else (`wholeFrame`), the SVG covers it opaquely, and the buffer
  ## still holds the SVG a render left there. `owed`: the scene background
  ## the target still owes, settled as renderSvgIntoTarget settles it.
  ## `reuse`: the caller hands back nodes it handed over before (a UI's
  ## layout), for pixie to keep their parse (parseSvg's `reuse`).
  if root.isNil:
    return false
  if panelBuffer.isNil or target.isNil or not wholeFrame or target.bufferPointer != panelBuffer:
    # Not the panel's own buffer (or not the whole frame): parsed and drawn
    # in one go, so the probe's raster carries its parse too.
    probe(phRaster):
      result = renderSvgIntoTarget(root, target, owed)
    return result
  let held =
    if not target.isView: panelHeld
    elif regionHeld.isSome and regionHeld.get().origin == target.origin: regionHeld
    else: none(HeldFrame)
  panelHeld = none(HeldFrame)
  regionHeld = none(HeldFrame)
  refreshDecodeBudgetInto(forDecode = false) # a frame decodes nothing: kept interpreters stay
  var parsed: Svg
  try:
    probe(phParse):
      parsed = parseSvg(root, target.width, target.height, reuse)
  except CatchableError:
    return false
  if not parsed.coversOpaque(target.width, target.height):
    # Pixels from before can show through: draw it whole, keep nothing.
    try:
      if owed.isSome:
        payBackground(target, owed.get())
        owed = none(Color)
      probe(phRaster):
        parsed.renderInto(target)
    except CatchableError:
      return false
    return true
  owed = none(Color) # waived: the SVG's first paint covers every pixel
  let whole = target.width * target.height
  var
    rects = @[(x: 0, y: 0, w: target.width, h: target.height)]
    base: Option[HeldFrame] # the frame the buffer holds after any copy
  probe(phDamage):
    if held.isSome and held.get().generation == panelGeneration and
        held.get().width == target.width and held.get().height == target.height:
      rects = damageRects(held.get().svg, parsed, target.width, target.height, MaxRepaints).rects
      # Its own frame is the base only when it saves a repaint. Assigned
      # here unconditionally, the copy below assigned `base` a second time,
      # and Nim 2.2.4 builds that `base = some(...)` into `base` without
      # destroying what it held: every frame given up for another buffer's
      # (a scene switch, a scene coming back) leaked its whole parse, 16-45 KB
      # of PSRAM a switch on a SenseCAP Indicator, until the JSX UIs' idle
      # interpreters went for want of room and took their onClick with them
      # (2026-11-07). `base` is assigned once on any path now.
      if rects.area < whole:
        base = held
    if rects.area >= whole:
      # Its own frame is no help (none, written over, another scene's): the
      # newest frame another buffer holds, copied in, unless the damage
      # against that is the whole frame too.
      let source = newestHeldFrame(target)
      if source >= 0:
        let found = damageRects(heldFrames[source].svg, parsed, target.width, target.height, MaxRepaints)
        if not found.full and found.rects.area < whole:
          copyFrameIn(target, heldFrames[source].buffer)
          rects = found.rects
          base = some(heldFrames[source])
    if base.isSome and rects.area < whole:
      # Canvases drawn into since: pixie sees the same picture in them.
      rects.add canvasRects(base.get(), parsed, target)
  when defined(testing):
    svgFramePixelsForTest = 0
  try:
    probe(phRaster):
      for r in rects:
        if r.w == target.width and r.h == target.height:
          parsed.renderInto(target)
        else:
          parsed.renderInto(target.view(r.x, r.y, r.w, r.h), r.x, r.y)
        when defined(testing):
          svgFramePixelsForTest += r.w * r.h
  except CatchableError:
    return false
  if target.isView:
    # One record per rectangle, whoever left the last one.
    let stale = target.regionRecord
    if stale >= 0:
      heldFrames.delete(stale)
  if heldFrames.len >= MaxHeldFrames:
    heldFrames.delete(0)
  heldFrames.add(HeldFrame(buffer: panelBuffer, generation: panelGeneration, isRegion: target.isView,
    origin: target.origin, width: target.width, height: target.height, svg: parsed,
    canvases: parsed.canvasesShown))
  true

proc renderSvgFrame*(svg: string, target: Image, owed: var Option[Color], wholeFrame: bool): bool =
  renderSvgFrame(svgRoot(svg), target, owed, wholeFrame)

{.pop.}

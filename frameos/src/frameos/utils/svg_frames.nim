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

import std/options
import pixie
import pixie/fileformats/svg
import frameos/utils/canvas_log
import frameos/utils/image
import frameos/utils/memory

const MaxRepaints = 6
  ## Boxes a frame repaints at most (pixie's damageRects joins the rest):
  ## each costs a look at every element's bounds, and those over it.

type HeldFrame = object
  buffer: pointer
  generation: uint32
  width, height: int
  svg: Svg
  canvases: seq[tuple[image: Image, version: int]]
    ## the version of each canvas the frame showed (utils/canvas_log.nim)

var
  heldFrames: seq[HeldFrame] ## oldest first
  panelBuffer: pointer
  panelGeneration: uint32
  panelHeld: Option[HeldFrame]
  panelBufferGeneration*: proc(buffer: pointer): int64 {.nimcall, raises: [].}
    ## The firmware's write generation of any of the panel's buffers, -1 for
    ## one it does not know (embedded_runtime: fos_display_buffer_generation).
    ## Unset, a buffer without its own record is drawn whole.

when defined(testing):
  var svgFramePixelsForTest* = 0
    ## Pixels the last renderSvgFrame repainted (test_svg_frames.nim).

proc beginPanelFrame*(buffer: pointer, generation: uint32) =
  ## A render into the panel buffer `buffer` begins; `generation` counts the
  ## writes the firmware made into it (anything but a render in place).
  panelBuffer = buffer
  panelGeneration = generation
  panelHeld = none(HeldFrame)
  for i in 0 ..< heldFrames.len:
    if heldFrames[i].buffer == buffer:
      panelHeld = some(heldFrames[i])
      heldFrames.delete(i)
      break

proc endPanelFrame*() =
  panelBuffer = nil
  panelHeld = none(HeldFrame)

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
        frame.height == target.height and
        panelBufferGeneration(frame.buffer) == frame.generation.int64:
      return i
  -1

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
  endPanelFrame()

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
  if panelBuffer.isNil or target.isNil or target.isView or not wholeFrame or
      target.bufferPointer != panelBuffer:
    return renderSvgIntoTarget(root, target, owed)
  let held = panelHeld
  panelHeld = none(HeldFrame)
  refreshDecodeBudgetInto(forDecode = false) # a frame decodes nothing: kept interpreters stay
  var parsed: Svg
  try:
    parsed = parseSvg(root, target.width, target.height, reuse)
  except CatchableError:
    return false
  if not parsed.coversOpaque(target.width, target.height):
    # Pixels from before can show through: draw it whole, keep nothing.
    try:
      if owed.isSome:
        payBackground(target, owed.get())
        owed = none(Color)
      parsed.renderInto(target)
    except CatchableError:
      return false
    return true
  owed = none(Color) # waived: the SVG's first paint covers every pixel
  let whole = target.width * target.height
  var
    rects = @[(x: 0, y: 0, w: target.width, h: target.height)]
    base: Option[HeldFrame] # the frame the buffer holds after any copy
  if held.isSome and held.get().generation == panelGeneration and
      held.get().width == target.width and held.get().height == target.height:
    rects = damageRects(held.get().svg, parsed, target.width, target.height, MaxRepaints).rects
    base = held
  if rects.area >= whole:
    # Its own frame is no help (none, written over, another scene's): the
    # newest frame another buffer holds, copied in, unless the damage
    # against that is the whole frame too.
    let source = newestHeldFrame(target)
    if source >= 0:
      let found = damageRects(heldFrames[source].svg, parsed, target.width, target.height, MaxRepaints)
      if not found.full and found.rects.area < whole:
        copyMem(target.bufferPointer, heldFrames[source].buffer, target.byteSize)
        rects = found.rects
        base = some(heldFrames[source])
  if base.isSome and rects.area < whole:
    # Canvases drawn into since: pixie sees the same picture in them.
    rects.add canvasRects(base.get(), parsed, target)
  when defined(testing):
    svgFramePixelsForTest = 0
  try:
    for r in rects:
      if r.w == target.width and r.h == target.height:
        parsed.renderInto(target)
      else:
        parsed.renderInto(target.view(r.x, r.y, r.w, r.h), r.x, r.y)
      when defined(testing):
        svgFramePixelsForTest += r.w * r.h
  except CatchableError:
    return false
  heldFrames.add(HeldFrame(buffer: panelBuffer, generation: panelGeneration,
    width: target.width, height: target.height, svg: parsed, canvases: parsed.canvasesShown))
  true

proc renderSvgFrame*(svg: string, target: Image, owed: var Option[Color], wholeFrame: bool): bool =
  renderSvgFrame(svgRoot(svg), target, owed, wholeFrame)

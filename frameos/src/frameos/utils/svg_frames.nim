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
## no record behind and the next frame into that buffer is drawn whole.

import std/options
import pixie
import pixie/fileformats/svg
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

var
  heldFrames: seq[HeldFrame]
  panelBuffer: pointer
  panelGeneration: uint32
  panelHeld: Option[HeldFrame]

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
  refreshDecodeBudgetInto()
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
  var rects = @[(x: 0, y: 0, w: target.width, h: target.height)]
  if held.isSome and held.get().generation == panelGeneration and
      held.get().width == target.width and held.get().height == target.height:
    rects = damageRects(held.get().svg, parsed, target.width, target.height, MaxRepaints).rects
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
    width: target.width, height: target.height, svg: parsed))
  true

proc renderSvgFrame*(svg: string, target: Image, owed: var Option[Color], wholeFrame: bool): bool =
  renderSvgFrame(svgRoot(svg), target, owed, wholeFrame)

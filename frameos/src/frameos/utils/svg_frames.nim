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
## render into it then repaints pixie's `damage` box between the two SVGs
## and leaves the rest as it is: for DVD Logo Bounce on the SenseCAP
## Indicator, a box around the logo instead of 230,400 pixels.
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

proc renderSvgFrame*(svg: string, target: Image, owed: var Option[Color], wholeFrame: bool): bool =
  ## renderSvgIntoTarget, repainting only the damage when `target` is the
  ## panel buffer this render began on (beginPanelFrame), the render draws
  ## nothing else (`wholeFrame`), the SVG covers it opaquely, and the buffer
  ## still holds the SVG a render left there. `owed`: the scene background
  ## the target still owes, settled as renderSvgIntoTarget settles it.
  if panelBuffer.isNil or target.isNil or target.isView or not wholeFrame or
      target.bufferPointer != panelBuffer:
    return renderSvgIntoTarget(svg, target, owed)
  let held = panelHeld
  panelHeld = none(HeldFrame)
  refreshDecodeBudgetInto()
  var parsed: Svg
  try:
    parsed = parseSvg(svg, target.width, target.height)
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
  var box = (full: true, x: 0, y: 0, w: target.width, h: target.height)
  if held.isSome and held.get().generation == panelGeneration and
      held.get().width == target.width and held.get().height == target.height:
    box = damage(held.get().svg, parsed, target.width, target.height)
  try:
    if box.full:
      parsed.renderInto(target)
      box = (true, 0, 0, target.width, target.height)
    elif box.w > 0:
      parsed.renderInto(target.view(box.x, box.y, box.w, box.h), box.x, box.y)
  except CatchableError:
    return false
  when defined(testing):
    svgFramePixelsForTest = box.w * box.h
  heldFrames.add(HeldFrame(buffer: panelBuffer, generation: panelGeneration,
    width: target.width, height: target.height, svg: parsed))
  true

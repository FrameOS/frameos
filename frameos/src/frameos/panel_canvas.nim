## The Linux runner's canvas when the panel takes RGB565 as it is.
##
## A HyperPixel 4.0 (or any 16 bpp framebuffer in RGB565 order) shows exactly
## what a pixie `pfRgb565` image holds. When its driver says so
## (frameos/driver_render_hint `panelCanvas`), the runner renders every frame
## into one 565 canvas kept for the whole uptime, the way an ESP32 LCD does
## (embedded_runtime `renderCanvas`):
##
## * there is nothing to convert: the driver compares the canvas with what
##   the panel shows and writes the rows that changed
##   (drivers/frameBuffer/panel_push.nim);
## * the canvas still holds the last frame when the next one starts, so a
##   scene whose render is one SVG repaints only what changed
##   (utils/svg_frames.nim), with `generation` counting every write into the
##   canvas that was not that render.
##
## Unrotated, unflipped and at the panel's own size only: anything else goes
## through the RGBA canvas, the scaling and the rotation as before. Stores
## are dithered (`ditherStores`) as on the ESP32, so a gradient on the glass
## does not step every eight levels.

import pixie
import frameos/driver_render_hint
import frameos/utils/svg_frames

var
  canvas: Image
  generation: uint32

proc panelCanvasFits*(panel: tuple[width, height, format: int], frameWidth, frameHeight,
    renderWidth, renderHeight, rotate: int, flip: string): bool =
  ## Whether a frame renders into the panel canvas: the driver takes RGB565
  ## at exactly the size the scene renders at, with nothing to turn or mirror.
  panel.format == PanelCanvasRgb565 and rotate == 0 and
    flip notin ["horizontal", "vertical", "both"] and
    panel.width == frameWidth and panel.height == frameHeight and
    renderWidth == frameWidth and renderHeight == frameHeight

proc panelCanvasFor*(frameWidth, frameHeight, renderWidth, renderHeight, rotate: int,
    flip: string): Image =
  ## The canvas this render draws into, or nil for "a fresh RGBA one". Made
  ## on first use and kept; dropped (with everything svg_frames held about
  ## it) once it no longer fits.
  if not panelCanvasFits(panelCanvas(), frameWidth, frameHeight, renderWidth, renderHeight,
      rotate, flip):
    if not canvas.isNil:
      canvas = nil
      forgetPanelFrames()
    return nil
  if canvas.isNil or canvas.width != frameWidth or canvas.height != frameHeight:
    forgetPanelFrames()
    canvas = newImage565(frameWidth, frameHeight)
    canvas.ditherStores = true
    generation += 1
  canvas

proc isPanelCanvas*(image: Image): bool =
  not image.isNil and not canvas.isNil and image == canvas

proc notePanelCanvasWritten*() =
  ## Something other than the scene's render drew into the canvas (an
  ## overlay, a colour correction): it no longer holds the frame svg_frames
  ## recorded, so the next render draws whole.
  generation += 1

proc beginPanelCanvasFrame*(image: Image) =
  if image.isPanelCanvas:
    beginPanelFrame(image.bufferPointer, generation)

proc endPanelCanvasFrame*() =
  endPanelFrame()

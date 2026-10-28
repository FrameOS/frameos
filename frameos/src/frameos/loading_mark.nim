## The loading mark: what an LCD shows while a scene switch loads
## (docs/realtime-rendering.md "A switch that takes a while").
##
## A switch on a fast display used to give no sign that anything was
## happening while the next scene was being built, for as long as that took.
## Now, when the new scene has not put its first frame on the panel within
## `LoadingMarkDelayMs`, a small animated mark is drawn over the picture the
## panel still shows, and it goes the moment the new frame lands. A switch
## that is quicker than the delay looks exactly as it did before.
##
## This module is the mark itself, the same on every host: its timing, where
## it sits and what each frame of it looks like. It draws into a rectangle of
## the panel's own pixels, composing over a copy of what was there, so a host
## puts the mark away by writing that copy back. It allocates nothing, raises
## nothing and touches no ref: the ESP32 runs it on a task of its own on the
## other core (`frameos_nim_loading_mark_draw`, lcd_st7701s_rgb.c), the Linux
## runtime on a thread of its own (loading_mark_panel.nim), while the render
## path is busy loading the scene.
##
## Coordinates: a mark is placed in the frame as the viewer sees it (the
## scene's own orientation) and drawn in panel pixels, through frame.json's
## `flip` (applied to the frame first) and `rotate` (the turn onto the panel),
## the mapping utils/image.nim `rotateDegrees` uses.
##
## Flash is the ESP32's budget, so it builds only what its one LCD needs: the
## default style, RGB565, no flip, no round panel (`AllStyles`, `Only565`,
## `Flips`, `RoundPanels`). A Pi builds all of it.

import std/math

{.push checks: off, stackTrace: off, raises: [], quirky: on.}

type
  LoadingMarkStyle* = enum
    lmOff = 0
    lmDots = 1     ## three dots in a small dark pill, top right, pulsing in turn
    lmSpinner = 2  ## eight spokes on a small dark disc, top right, turning
    lmSquares = 3  ## a 3x3 grid of squares, top right, inverted in a ring
    lmBar = 4      ## a thin bar along the top edge, a bright stretch sweeping it

  MarkRect* {.bycopy.} = object
    ## Panel pixels; `w` 0 for nothing to draw.
    x*, y*, w*, h*: int32

  MarkPixels* = object
    ## How a panel row holds a pixel.
    bytesPerPixel*: int32 ## 2: RGB565, one little-endian word; 3 or 4: one byte per channel
    redByte*, greenByte*, blueByte*: int32

  MarkView* = object
    ## The panel as the mark sees it.
    panelWidth*, panelHeight*: int32
    rotation*: int32 ## frame.json `rotate`: 0, 90, 180 or 270
    flipX*, flipY*: bool ## frame.json `flip`, applied to the frame before the turn
    round*: bool ## only the inscribed circle shows (panel_shape.nim `panelIsRound`: the HyperPixel 2.1 Round)

const
  LoadingMarkDelayMs* = 200
    ## How long a switch may take before the mark shows. Up to ~100 ms a
    ## change reads as instant, and from ~250 ms a pause starts to read as
    ## "did it hear me": 200 ms leaves a quick switch (most scenes on a Pi)
    ## exactly as it was, with room to spare, and answers before the pause
    ## reads as one. Pinned to the C copy in lcd_loading.h by
    ## test_esp32_lcd_loading.py.
  LoadingMarkFrameMs* = 50
    ## How often a showing mark is drawn again: 20 frames a second, the LCD
    ## boot splash's rate.
  RgbMarkPixels* = MarkPixels(bytesPerPixel: 4, redByte: 0, greenByte: 1, blueByte: 2)
    ## pixie's RGBX, for the previews and the tests.
  Rgb565MarkPixels* = MarkPixels(bytesPerPixel: 2)

proc parseLoadingMarkStyle*(name: string): LoadingMarkStyle =
  ## frame.json `loadingIndicator`: "dots" (also "" and anything unknown),
  ## "spinner", "squares", "bar", or "off" / "none" for no mark at all.
  case name
  of "spinner": lmSpinner
  of "squares": lmSquares
  of "bar": lmBar
  of "off", "none": lmOff
  else: lmDots

proc loadingMarkTime*(elapsedMs: int64): int32 =
  ## How far into its animation the mark is `elapsedMs` after the switch was
  ## asked for: -1 while it is not due yet.
  if elapsedMs < LoadingMarkDelayMs: -1'i32
  else: int32(min(elapsedMs - LoadingMarkDelayMs, int64(high(int32))))

# ----------------------------------------------------------------- geometry

proc frameSize(view: MarkView): tuple[w, h: int32] =
  ## The frame as the scene drew it: the panel's size before the turn.
  if view.rotation == 90 or view.rotation == 270: (view.panelHeight, view.panelWidth)
  else: (view.panelWidth, view.panelHeight)

proc markUnit(fw, fh: int32): float32 =
  ## The mark's size scales with the frame's shorter side: 4.6 px on a 480 px
  ## panel, 10 on 1080p.
  max(2'f32, float32(min(fw, fh)) / 105'f32)

type Shape = object
  ## Where a style sits, in the viewer's frame coordinates: its box, and for
  ## the bar on a round panel the arc it runs along.
  x, y, w, h: float32
  arc: bool
  cx, cy, rIn, rOut: float32
  bump: array[3, float32] ## the dots' pulse this frame, worked out once a frame

const
  RoundPanels = not defined(freertos)
    ## No ESP32 board is round: the round placement is not built there.
  AllStyles = not defined(freertos)
    ## Flash is the ESP32's budget: it builds the default style alone (the
    ## dots), with no setting to pick another. A Pi has all of them.
  Flips = not defined(freertos)
    ## The ESP32 has no frame.json `flip`.
  ArcSin = 0.61566'f32 ## the bar's arc on a round panel: 38 degrees either
  ArcCos = 0.78801'f32 ## side of twelve o'clock
  ArcHalfSpan = 0.66323'f32 ## the same in radians

proc roundInset(u: float32): float32 =
  ## How far in from the rim of a round panel the mark keeps (the glass's
  ## edge is not a place to look for it): 14 px on the 480 px Round.
  max(14'f32, 3'f32 * u)

proc markShape(style: LoadingMarkStyle, fw, fh: int32, round: bool): Shape =
  let u = markUnit(fw, fh)
  let margin = 3'f32 * u
  when not AllStyles:
    let (w, h) = (10.8'f32 * u, 4.4'f32 * u)
    return Shape(x: float32(fw) - margin - w, y: margin, w: w, h: h)
  else:
    # A round panel shows only the circle inside its square (the HyperPixel
    # 2.1 Round): the corners and most of the top edge are not on the glass.
    let circle = RoundPanels and round
    let (cx, cy, radius) = (float32(fw) / 2, float32(fh) / 2, float32(min(fw, fh)) / 2)
    case style
    of lmBar:
      let thick = max(2'f32, float32(int(0.75'f32 * u + 0.5'f32)))
      if circle:
        # An arc along the top of the rim instead of the top edge.
        let rOut = radius - roundInset(u)
        let rIn = rOut - thick
        Shape(x: cx - rOut * ArcSin, y: cy - rOut, w: 2 * rOut * ArcSin, h: rOut - rIn * ArcCos,
          arc: true, cx: cx, cy: cy, rIn: rIn, rOut: rOut)
      else:
        Shape(x: 0, y: 0, w: float32(fw), h: thick)
    of lmOff:
      Shape()
    else:
      let (w, h) =
        case style
        of lmDots: (10.8'f32 * u, 4.4'f32 * u)
        of lmSpinner: (7'f32 * u, 7'f32 * u)
        else: (6.2'f32 * u, 6.2'f32 * u)
      if circle:
        # Up and to the right along the rim, 45 degrees, with the box's far
        # corner `roundInset` inside the circle: its centre is (cx + a, cy - a)
        # for the `a` that puts (a + w/2, a + h/2) at that distance.
        let reach = radius - roundInset(u)
        let a = (sqrt((w + h) * (w + h) - 8 * ((w * w + h * h) / 4 - reach * reach)) - (w + h)) / 4
        Shape(x: cx + a - w / 2, y: cy - a - h / 2, w: w, h: h)
      else:
        Shape(x: float32(fw) - margin - w, y: margin, w: w, h: h)

proc loadingMarkRect*(view: MarkView, style: LoadingMarkStyle): MarkRect =
  ## The panel rectangle the mark draws in, clipped to the panel. The host
  ## saves what is there before the first frame of the mark and writes it
  ## back to put it away.
  if style == lmOff or view.panelWidth <= 0 or view.panelHeight <= 0:
    return MarkRect()
  let (fw, fh) = view.frameSize
  let shape = markShape(style, fw, fh, view.round)
  # A pixel of soft edge on every side.
  var x0 = max(0'i32, int32(shape.x) - 1)
  var y0 = max(0'i32, int32(shape.y) - 1)
  var x1 = min(fw, int32(shape.x + shape.w) + 2)
  var y1 = min(fh, int32(shape.y + shape.h) + 2)
  if x1 <= x0 or y1 <= y0:
    return MarkRect()
  # The viewer's frame to the frame as drawn (flip), then onto the panel (turn).
  when Flips:
    if view.flipX: (x0, x1) = (fw - x1, fw - x0)
    if view.flipY: (y0, y1) = (fh - y1, fh - y0)
  case view.rotation
  of 90: MarkRect(x: fh - y1, y: x0, w: y1 - y0, h: x1 - x0)
  of 180: MarkRect(x: fw - x1, y: fh - y1, w: x1 - x0, h: y1 - y0)
  of 270: MarkRect(x: y0, y: fw - x1, w: y1 - y0, h: x1 - x0)
  else: MarkRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)

proc viewerPoint(view: MarkView, fw, fh, px, py: int32): tuple[x, y: int32] {.inline.} =
  ## A panel pixel, back in the viewer's frame.
  var (fx, fy) =
    case view.rotation
    of 90: (py, fh - 1 - px)
    of 180: (fw - 1 - px, fh - 1 - py)
    of 270: (fw - 1 - py, px)
    else: (px, py)
  when Flips:
    if view.flipX: fx = fw - 1 - fx
    if view.flipY: fy = fh - 1 - fy
  (fx, fy)

# ------------------------------------------------------------------ the look

type Paint = object
  ## What a style does to one pixel, each 0..1: inverts it, then darkens it
  ## (a backdrop), then lightens it (the mark itself).
  invert, dark, light: float32

proc cover(distance: float32): float32 {.inline.} =
  ## Coverage of a pixel whose center is `distance` outside a shape's edge
  ## (negative inside): a one-pixel ramp.
  clamp(0.5'f32 - distance, 0'f32, 1'f32)

proc segmentDistance(px, py, ax, ay, bx, by: float32): float32 {.inline.} =
  let (dx, dy) = (bx - ax, by - ay)
  let t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0'f32, 1'f32)
  let (ex, ey) = (px - ax - t * dx, py - ay - t * dy)
  sqrt(ex * ex + ey * ey)

proc pulse(tMs: int32, index: int32): float32 =
  ## The dots' wave: each dot swells and brightens for 45% of a 1.2 s cycle,
  ## the next one 15% of a cycle later. A bump of 0..1 without trigonometry.
  let cycle = 1200'i32
  var phase = float32((tMs + cycle - index * 180) mod cycle) / float32(cycle)
  if phase >= 0.45'f32:
    return 0
  let q = phase / 0.45'f32
  16'f32 * q * q * (1 - q) * (1 - q)

proc paintDots(shape: Shape, u: float32, x, y: float32): Paint {.inline.} =
  let r = shape.h / 2
  let cy = shape.y + r
  let dx = max(max(shape.x + r - x, 0'f32), x - (shape.x + shape.w - r))
  let dy = y - cy
  result.dark = 0.5'f32 * cover(sqrt(dx * dx + dy * dy) - r)
  if result.dark <= 0:
    return
  for i in 0'i32 .. 2'i32:
    let bump = shape.bump[i]
    let cx = shape.x + r + float32(i) * 3.2'f32 * u
    let (ex, ey) = (x - cx, y - cy)
    let radius = u * (0.85'f32 + 0.35'f32 * bump)
    let alpha = (0.45'f32 + 0.55'f32 * bump) * cover(sqrt(ex * ex + ey * ey) - radius)
    result.light = max(result.light, alpha)

when AllStyles:
  # The other styles are a Pi's (frame.json `loadingIndicator`): the ESP32
  # builds the dots alone.
  const SpokeDirections = [(0'f32, -1'f32), (0.7071'f32, -0.7071'f32), (1'f32, 0'f32),
    (0.7071'f32, 0.7071'f32), (0'f32, 1'f32), (-0.7071'f32, 0.7071'f32), (-1'f32, 0'f32),
    (-0.7071'f32, -0.7071'f32)]
    ## Twelve o'clock, then clockwise.

  const SquareRing = [(0'i32, 0'i32), (1'i32, 0'i32), (2'i32, 0'i32), (2'i32, 1'i32),
    (2'i32, 2'i32), (1'i32, 2'i32), (0'i32, 2'i32), (0'i32, 1'i32)]
    ## The grid's outer squares, clockwise from the top left.

  proc paintAt(style: LoadingMarkStyle, shape: Shape, u: float32, tMs: int32, x, y: float32): Paint =
    case style
    of lmDots:
      result = paintDots(shape, u, x, y)
    of lmSpinner:
      let r = shape.w / 2
      let (cx, cy) = (shape.x + r, shape.y + r)
      let (ex, ey) = (x - cx, y - cy)
      result.dark = 0.5'f32 * cover(sqrt(ex * ex + ey * ey) - r)
      if result.dark <= 0:
        return
      let head = (tMs div 100) mod 8
      for k in 0'i32 .. 7'i32:
        let (sx, sy) = SpokeDirections[k]
        let age = (head - k + 8) mod 8
        let alpha = 1'f32 - float32(age) * 0.105'f32
        let distance = segmentDistance(x, y, cx + 1.35'f32 * u * sx, cy + 1.35'f32 * u * sy,
          cx + 2.45'f32 * u * sx, cy + 2.45'f32 * u * sy) - 0.45'f32 * u
        result.light = max(result.light, alpha * cover(distance))
    of lmSquares:
      let size = 1.6'f32 * u
      let step = size + 0.7'f32 * u
      let (gx, gy) = ((x - shape.x) / step, (y - shape.y) / step)
      if gx < 0 or gy < 0 or gx >= 3 or gy >= 3:
        return
      let (i, j) = (int32(gx), int32(gy))
      let inside = min(cover((float32(gx) - float32(i)) * step - size),
                       cover((float32(gy) - float32(j)) * step - size))
      if inside <= 0:
        return
      let head = (tMs div 150) mod 8
      for position, cell in SquareRing:
        if cell == (i, j):
          let age = (head - int32(position) + 8) mod 8
          # The head inverted whole, two behind it fading, the rest of the
          # ring faintly, so the grid reads as one shape.
          let amount = case age
            of 0: 1'f32
            of 1: 0.6'f32
            of 2: 0.32'f32
            else: 0.14'f32
          result.invert = amount * inside
    of lmBar:
      let cycle = 1500'i32
      let q = float32(tMs mod cycle) / float32(cycle)
      let ease = q * q * (3 - 2 * q)
      if RoundPanels and shape.arc:
        # Along the arc: the band between the radii, `p` 0..1 from its left
        # end to its right (by the sine of the angle from twelve o'clock).
        let (dx, dy) = (x - shape.cx, y - shape.cy)
        if dy >= 0:
          return
        let r = sqrt(dx * dx + dy * dy)
        let band = cover(abs(r - (shape.rIn + shape.rOut) / 2) - (shape.rOut - shape.rIn) / 2)
        if band <= 0:
          return
        let arcLength = 2 * ArcHalfSpan * (shape.rIn + shape.rOut) / 2
        let p = (dx / r / ArcSin + 1) / 2
        let ends = clamp(min(p, 1 - p) * arcLength / u, 0'f32, 1'f32)
        if ends <= 0:
          return
        result.dark = 0.35'f32 * band * ends
        let head = -0.3'f32 + ease * 1.3'f32
        let along = min(p - head, head + 0.3'f32 - p) * arcLength
        result.light = 0.95'f32 * band * ends * clamp(along / (2 * u), 0'f32, 1'f32)
        return
      if y >= shape.y + shape.h:
        return
      result.dark = 0.35'f32
      let length = 0.3'f32 * shape.w
      let head = -length + ease * (shape.w + length)
      let along = min(x - head, head + length - x)
      result.light = 0.95'f32 * clamp(along / (2 * u), 0'f32, 1'f32)
    of lmOff:
      discard
else:
  proc paintAt(style: LoadingMarkStyle, shape: Shape, u: float32, tMs: int32, x, y: float32): Paint {.inline.} =
    paintDots(shape, u, x, y)

# ------------------------------------------------------------------- pixels

const Only565 = defined(freertos)
  ## The ESP32's one LCD is RGB565: the byte-per-channel path is not built.

proc compose565(word: uint32, paint: Paint): uint32 {.inline.} =
  ## A 5/6/5 pixel with `paint` applied, in the panel's own steps: the
  ## coverages as 0..256, no float per channel and no division.
  var c = [(word shr 11) and 31, (word shr 5) and 63, word and 31]
  const top = [31'u32, 63, 31]
  let keep = 256'u32 - uint32(paint.dark * 256)
  let lift = uint32(paint.light * 256)
  for k in 0 .. 2:
    when AllStyles:
      if paint.invert > 0:
        let flip = int32(paint.invert * 256)
        c[k] = uint32(int32(c[k]) + (int32(top[k]) - 2 * int32(c[k])) * flip div 256)
    c[k] = c[k] * keep shr 8
    c[k] += (top[k] - c[k]) * lift shr 8
  (c[0] shl 11) or (c[1] shl 5) or c[2]

when not Only565:
  proc readPixel(pixels: MarkPixels, p: ptr UncheckedArray[uint8]): tuple[r, g, b: float32] {.inline.} =
    (float32(p[pixels.redByte]), float32(p[pixels.greenByte]), float32(p[pixels.blueByte]))

  proc writePixel(pixels: MarkPixels, p: ptr UncheckedArray[uint8], r, g, b: float32) {.inline.} =
    p[pixels.redByte] = uint8(clamp(r, 0, 255) + 0.5'f32)
    p[pixels.greenByte] = uint8(clamp(g, 0, 255) + 0.5'f32)
    p[pixels.blueByte] = uint8(clamp(b, 0, 255) + 0.5'f32)

  proc applyPaint(c: float32, paint: Paint): float32 {.inline.} =
    result = c
    if paint.invert > 0: result = result + paint.invert * (255 - 2 * result)
    if paint.dark > 0: result = result * (1 - paint.dark)
    if paint.light > 0: result = result + paint.light * (255 - result)

proc drawLoadingMark*(view: MarkView, style: LoadingMarkStyle, tMs: int32, rect: MarkRect,
    pixels: MarkPixels, src: ptr UncheckedArray[uint8], srcStride: int32,
    dst: ptr UncheckedArray[uint8], dstStride: int32) =
  ## Frame `tMs` of the mark: every pixel of `rect` composed from `src` (what
  ## the panel showed there, `rect`'s first pixel first, `srcStride` bytes a
  ## row) into `dst` (the same shape). A pixel the mark leaves alone is
  ## copied as it was. `src` and `dst` may be the same rows.
  if style == lmOff or rect.w <= 0 or rect.h <= 0 or src.isNil or dst.isNil:
    return
  let (fw, fh) = view.frameSize
  let u = markUnit(fw, fh)
  var shape = markShape(style, fw, fh, view.round)
  for i in 0'i32 .. 2'i32:
    shape.bump[i] = pulse(tMs, i)
  let bpp = when Only565: 2'i32 else: pixels.bytesPerPixel
  for row in 0'i32 ..< rect.h:
    let srcRow = cast[ptr UncheckedArray[uint8]](src[row * srcStride].addr)
    let dstRow = cast[ptr UncheckedArray[uint8]](dst[row * dstStride].addr)
    for col in 0'i32 ..< rect.w:
      let s = cast[ptr UncheckedArray[uint8]](srcRow[col * bpp].addr)
      let d = cast[ptr UncheckedArray[uint8]](dstRow[col * bpp].addr)
      let (vx, vy) = viewerPoint(view, fw, fh, rect.x + col, rect.y + row)
      let paint = paintAt(style, shape, u, tMs, float32(vx) + 0.5'f32, float32(vy) + 0.5'f32)
      if s != d:
        # The whole pixel first: a 32 bpp panel's fourth byte stays as it was.
        for k in 0'i32 ..< bpp:
          d[k] = s[k]
      if paint.dark <= 0 and paint.light <= 0 and (not AllStyles or paint.invert <= 0):
        continue
      if Only565 or bpp == 2:
        let word = compose565(uint32(s[0]) or (uint32(s[1]) shl 8), paint)
        d[0] = uint8(word and 0xFF)
        d[1] = uint8(word shr 8)
      else:
        when not Only565:
          let (r, g, b) = readPixel(pixels, s)
          writePixel(pixels, d, applyPaint(r, paint), applyPaint(g, paint), applyPaint(b, paint))

when defined(freertos):
  # The ESP32's RGB LCD (lcd_st7701s_rgb.c, through frameos_nim_glue.c):
  # plain values and pointers, on a task the Nim runtime knows nothing about
  # (like resample.nim's rows), never under the runtime's lock, and `quirky`
  # (pushed above), so nothing here reads the runtime's error flag. The dots,
  # unflipped: all the ESP32 builds.
  proc fos_nim_loading_mark_rect_impl(panelWidth, panelHeight, rotation: int32,
      rect: ptr MarkRect) {.exportc, cdecl, gcsafe.} =
    let view = MarkView(panelWidth: panelWidth, panelHeight: panelHeight, rotation: rotation)
    rect[] = loadingMarkRect(view, lmDots)

  proc fos_nim_loading_mark_draw_impl(panelWidth, panelHeight, rotation, tMs: int32,
      rect: ptr MarkRect, src: pointer, srcStride: int32, dst: pointer,
      dstStride: int32) {.exportc, cdecl, gcsafe.} =
    let view = MarkView(panelWidth: panelWidth, panelHeight: panelHeight, rotation: rotation)
    drawLoadingMark(view, lmDots, tMs, rect[], Rgb565MarkPixels,
      cast[ptr UncheckedArray[uint8]](src), srcStride, cast[ptr UncheckedArray[uint8]](dst), dstStride)

{.pop.}

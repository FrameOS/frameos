## The loading mark: what an LCD shows while a scene switch loads
## (docs/realtime-rendering.md "A switch that takes a while").
##
## A switch on a fast display used to give no sign that anything was
## happening while the next scene was being built, for as long as that took.
## Now, when the new scene has not put its first frame on the panel within
## `LoadingMarkDelayMs`, three dots in a small dark pill, pulsing in turn,
## are drawn over the picture the panel still shows, top right (top middle on
## a round panel), and they go the moment the new frame lands. A switch that is quicker than the delay
## looks exactly as it did before.
##
## This module is the mark itself, the same on every host: its timing, where
## it sits and what each frame of it looks like. It draws into a rectangle of
## the panel's own pixels, composing over a copy of what was there, so a host
## puts the mark away by writing that copy back. It allocates nothing, raises
## nothing and touches no ref: the ESP32 runs it on a task of its own on the
## other core (lcd_st7701s_rgb.c), the Linux runtime on a thread of its own
## (loading_mark_panel.nim), while the render path is busy loading the scene.
##
## Coordinates: the mark is placed in the frame as the viewer sees it (the
## scene's own orientation) and drawn in panel pixels, through frame.json's
## `flip` (applied to the frame first) and `rotate` (the turn onto the panel),
## the mapping utils/image.nim `rotateDegrees` uses.
##
## Flash is the ESP32's budget, so it builds only what its one LCD needs:
## RGB565, no flip, no round panel (`Only565`, `Flips`, `RoundPanels`).

import std/math

{.push checks: off, stackTrace: off, raises: [], quirky: on.}

type
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
  Only565 = defined(freertos)
    ## The ESP32's one LCD is RGB565: the byte-per-channel path is not built.
  Flips = not defined(freertos)
    ## The ESP32 has no frame.json `flip`.
  RoundPanels = not defined(freertos)
    ## No ESP32 board is round.

proc loadingMarkTime*(elapsedMs: int64): int32 =
  ## How far into its animation the mark is `elapsedMs` after the switch was
  ## asked for: -1 while it is not due yet.
  if elapsedMs < LoadingMarkDelayMs: -1'i32
  else: int32(min(elapsedMs - LoadingMarkDelayMs, int64(high(int32))))

# ----------------------------------------------------------------- geometry

const RoundInset = 14'f32
  ## On a round panel, how far inside the rim the pill's top corners stay.

type Pill = object
  ## The pill on the panel: its center in panel pixels, its size as the
  ## viewer sees it, the unit it is drawn in, and which way its three dots
  ## run there (across the panel or `down` it, from the `back` end or not).
  cx, cy, w, h, u: float32
  down, back: bool

proc pillOn(view: MarkView): Pill =
  ## The viewer's top right, scaled with the frame's shorter side (a unit of
  ## 4.6 px on a 480 px panel, 10 on 1080p), then through the flip and the
  ## turn onto the panel (utils/image.nim `rotateDegrees`'s mapping).
  let down = view.rotation == 90 or view.rotation == 270
  let (fw, fh) =
    if down: (float32(view.panelHeight), float32(view.panelWidth))
    else: (float32(view.panelWidth), float32(view.panelHeight))
  let u = max(2'f32, min(fw, fh) / 105'f32)
  let (w, h) = (10.8'f32 * u, 4.4'f32 * u)
  var x = fw - 8.4'f32 * u # its center, in the frame as the viewer sees it
  var y = 5.2'f32 * u
  when RoundPanels:
    if view.round:
      # Only the circle inside the square is glass: top middle there, as
      # high as its top corners stay `RoundInset` (or 3 units) inside the rim.
      let reach = min(fw, fh) / 2 - max(RoundInset, 3'f32 * u)
      x = fw / 2
      y = fh / 2 - sqrt(reach * reach - w * w / 4) + h / 2
  var back = false
  when Flips:
    if view.flipX:
      x = fw - x
      back = true
    if view.flipY:
      y = fh - y
  # A half turn is both flips; a quarter turn more swaps the axes.
  if view.rotation >= 180:
    x = fw - x
    y = fh - y
    back = not back
  if down:
    (x, y) = (fh - y, x)
  Pill(cx: x, cy: y, w: w, h: h, u: u, down: down, back: back)

proc loadingMarkRect*(view: MarkView): MarkRect =
  ## The panel rectangle the mark draws in, clipped to the panel. The host
  ## saves what is there before the first frame of the mark and writes it
  ## back to put it away.
  let pill = pillOn(view)
  let (rx, ry) = if pill.down: (pill.h / 2, pill.w / 2) else: (pill.w / 2, pill.h / 2)
  # A pixel of soft edge on every side.
  let x0 = max(0'i32, int32(pill.cx - rx) - 1)
  let y0 = max(0'i32, int32(pill.cy - ry) - 1)
  let x1 = min(view.panelWidth, int32(pill.cx + rx) + 2)
  let y1 = min(view.panelHeight, int32(pill.cy + ry) + 2)
  if x1 <= x0 or y1 <= y0:
    return MarkRect()
  MarkRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)

# ------------------------------------------------------------------ the look

proc cover(distance: float32): float32 {.inline.} =
  ## Coverage of a pixel whose center is `distance` outside a shape's edge
  ## (negative inside): a one-pixel ramp.
  min(max(0.5'f32 - distance, 0'f32), 1'f32)

proc pulse(tMs: int32, index: int32): float32 =
  ## The dots' wave: each dot swells and brightens for 540 ms of a 1.2 s
  ## cycle, the next one 180 ms later. A bump of 0..1 without trigonometry.
  let at = (tMs + 1200 - index * 180) mod 1200
  if at >= 540:
    return 0
  let q = float32(at) * (1'f32 / 540'f32)
  16'f32 * q * q * (1 - q) * (1 - q)

proc compose565(word: uint32, dark, light: float32): uint32 {.inline.} =
  ## A 5/6/5 pixel darkened by `dark` (towards black) and then lightened by
  ## `light` (towards white), at 32 levels each, its three channels spread
  ## out in one word so that one multiply does them all. Both 0: the pixel
  ## as it was.
  const lanes = 0x07E0F81F'u32 # green up high, red and blue low, room between
  let keep = 32'u32 - uint32(dark * 32)
  let lift = uint32(light * 32)
  var x = (word or (word shl 16)) and lanes
  x = ((x * keep) shr 5) and lanes
  x = ((x * (32 - lift) + lanes * lift) shr 5) and lanes
  (x or (x shr 16)) and 0xFFFF

proc drawLoadingMark*(view: MarkView, tMs: int32, rect: MarkRect, pixels: MarkPixels,
    src: ptr UncheckedArray[uint8], srcStride: int32, dst: ptr UncheckedArray[uint8],
    dstStride: int32) {.inline.} =
  ## Frame `tMs` of the mark: every pixel of `rect` composed from `src` (what
  ## the panel showed there, `rect`'s first pixel first, `srcStride` bytes a
  ## row) into `dst` (the same shape). A pixel the mark leaves alone is
  ## copied as it was. `src` and `dst` may be the same rows.
  let pill = pillOn(view)
  let u = pill.u
  let r = pill.h / 2
  let ends = pill.w / 2 - r # the center to its round ends' centers
  let gap = 3.2'f32 * u     # one dot's center to the next's
  # Each dot's size and brightness this frame.
  var radius {.noinit.}, alpha {.noinit.}: array[3, float32]
  for i in 0'i32 .. 2'i32:
    let bump = pulse(tMs, i)
    radius[i] = u * (0.85'f32 + 0.35'f32 * bump)
    alpha[i] = 0.45'f32 + 0.55'f32 * bump
  let bpp = when Only565: 2'i32 else: pixels.bytesPerPixel
  for row in 0'i32 ..< rect.h:
    let srcRow = cast[ptr UncheckedArray[uint8]](src[row * srcStride].addr)
    let dstRow = cast[ptr UncheckedArray[uint8]](dst[row * dstStride].addr)
    let py = float32(rect.y + row) + 0.5'f32 - pill.cy
    for col in 0'i32 ..< rect.w:
      # From the pill's center, along its dots (x) and across them (y).
      var x = float32(rect.x + col) + 0.5'f32 - pill.cx
      var y = py
      if pill.down: swap(x, y)
      if pill.back: x = -x
      # The pill: a capsule, at half strength.
      let ex = max(abs(x) - ends, 0'f32)
      let dark = 0.5'f32 * cover(sqrt(ex * ex + y * y) - r)
      var light = 0'f32
      if dark > 0:
        # The dot nearest: they never overlap, so it is the only one there.
        let k = min(max(int32(x / gap + 1.5'f32), 0'i32), 2'i32)
        let dx = x - float32(k - 1) * gap
        light = alpha[k] * cover(sqrt(dx * dx + y * y) - radius[k])
      if Only565 or bpp == 2:
        # One little-endian word a pixel, as both hosts are.
        let s = cast[ptr UncheckedArray[uint16]](srcRow)
        let d = cast[ptr UncheckedArray[uint16]](dstRow)
        d[col] = uint16(compose565(uint32(s[col]), dark, light))
      else:
        when not Only565:
          let s = cast[ptr UncheckedArray[uint8]](srcRow[col * bpp].addr)
          let d = cast[ptr UncheckedArray[uint8]](dstRow[col * bpp].addr)
          if s != d:
            # The whole pixel first: a 32 bpp panel's fourth byte stays as it was.
            for k in 0'i32 ..< bpp:
              d[k] = s[k]
          for channel in [pixels.redByte, pixels.greenByte, pixels.blueByte]:
            var c = float32(s[channel]) * (1 - dark)
            c += light * (255 - c)
            d[channel] = uint8(c + 0.5'f32)

when defined(freertos):
  # The ESP32's RGB LCD (lcd_st7701s_rgb.c): plain values and pointers, on a
  # task the Nim runtime knows nothing about (like resample.nim's rows),
  # never under the runtime's lock, and `quirky` (pushed above), so nothing
  # here reads the runtime's error flag. One entry for both questions: with
  # no `src` it is where the mark goes, else one frame of it.
  proc loadingMarkEntry(panelWidth, panelHeight, rotation, tMs: int32, rect: ptr MarkRect,
      src: pointer, srcStride: int32, dst: pointer, dstStride: int32) {.cdecl.} =
    let view = MarkView(panelWidth: panelWidth, panelHeight: panelHeight, rotation: rotation)
    if src.isNil:
      rect[] = loadingMarkRect(view)
    else:
      drawLoadingMark(view, tMs, rect[], Rgb565MarkPixels, cast[ptr UncheckedArray[uint8]](src),
        srcStride, cast[ptr UncheckedArray[uint8]](dst), dstStride)

  proc setLoadingMark(mark: pointer) {.importc: "fos_lcd_st7701s_set_loading_mark", cdecl.}
  # The panel's driver draws with it from here on (a thin-client image,
  # without this runtime, has none, and no mark).
  setLoadingMark(cast[pointer](loadingMarkEntry))

{.pop.}

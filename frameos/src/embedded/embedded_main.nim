# FrameOS embedded runtime (M2: Nim core on the metal).
#
# Compiled with `--os:freertos --cpu:esp --compileOnly` into C and built as
# the ESP-IDF component embedded/esp32/components/frameos_nim (see
# embedded/esp32/build_nim.sh). The firmware drives it through the small
# C API below; pixie does the rendering, the Nim heap lives in PSRAM via
# -d:useMalloc + CONFIG_SPIRAM_USE_MALLOC.

import std/[monotimes, strformat, times]
import pixie

import embedded_scene

# ------------------------------------------------------------------ C hooks

proc espLog(msg: cstring) {.importc: "frameos_nim_log_hook", cdecl.}

proc log*(msg: string) =
  espLog(msg.cstring)

# ------------------------------------------------------------------- state

var
  frameWidth = 0
  frameHeight = 0
  frameName = ""
  renderCount = 0
  lastRenderMs = 0
  infoBuffer: string

# ------------------------------------------------------- dither + packing
# Floyd–Steinberg to packed 1bpp (white=1, MSB first) — the format the
# Waveshare EPD_7in5_V2 driver expects. Kept here for the embedded runtime;
# the Linux build has its own packing in drivers/waveshare.

proc packImage1bpp(image: Image; buf: ptr UncheckedArray[uint8]; bufLen: int): bool =
  let
    width = image.width
    height = image.height
    rowBytes = (width + 7) div 8
  if rowBytes * height != bufLen:
    log(&"pack: buffer mismatch, want {rowBytes * height} bytes, got {bufLen}")
    return false

  var
    currentError = newSeq[float32](width + 2)
    nextError = newSeq[float32](width + 2)

  for i in 0 ..< bufLen:
    buf[i] = 0

  for y in 0 ..< height:
    for x in 0 ..< width:
      let pixel = image.data[image.dataIndex(x, y)]
      let gray = (pixel.r.float32 * 0.299f + pixel.g.float32 * 0.587f +
                  pixel.b.float32 * 0.114f) / 255.0f + currentError[x + 1]
      let white = gray >= 0.5f
      if white:
        buf[y * rowBytes + (x shr 3)] = buf[y * rowBytes + (x shr 3)] or
          (0x80'u8 shr (x and 7))
      let error = gray - (if white: 1.0f else: 0.0f)
      currentError[x + 2] += error * 7.0f / 16.0f
      nextError[x] += error * 3.0f / 16.0f
      nextError[x + 1] += error * 5.0f / 16.0f
      nextError[x + 2] += error * 1.0f / 16.0f
    swap(currentError, nextError)
    for i in 0 ..< nextError.len:
      nextError[i] = 0

  true

# ------------------------------------------------------------------ C API

proc fos_nim_init_impl(width, height: cint; name: cstring): bool {.exportc, cdecl.} =
  frameWidth = width.int
  frameHeight = height.int
  frameName = $name
  try:
    initScene()
    log(&"nim runtime initialized: {frameWidth}x{frameHeight} \"{frameName}\", nim {NimVersion}")
    true
  except CatchableError as e:
    log("nim init failed: " & e.msg)
    false

proc fos_nim_render_1bpp_impl(buf: ptr UncheckedArray[uint8]; bufLen: csize_t): cint {.exportc, cdecl.} =
  try:
    let start = getMonoTime()
    let image = render(frameWidth, frameHeight, frameName, renderCount + 1)
    let renderedAt = getMonoTime()
    if not packImage1bpp(image, buf, bufLen.int):
      return 1
    let packed = getMonoTime()
    inc renderCount
    lastRenderMs = ((packed - start).inMilliseconds).int
    log(&"render #{renderCount}: scene {(renderedAt - start).inMilliseconds} ms, " &
        &"dither+pack {(packed - renderedAt).inMilliseconds} ms")
    0
  except CatchableError as e:
    log("render failed: " & e.msg)
    1

proc fos_nim_info_impl(): cstring {.exportc, cdecl.} =
  infoBuffer = &"nim {NimVersion} + pixie, {frameWidth}x{frameHeight}, " &
               &"renders={renderCount}, last={lastRenderMs} ms"
  infoBuffer.cstring

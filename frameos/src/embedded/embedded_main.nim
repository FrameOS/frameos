# FrameOS embedded runtime: Nim renderer plus interpreted scenes via QuickJS.
#
# Compiled with `--os:freertos --cpu:esp --compileOnly` into C and built as
# the ESP-IDF component embedded/esp32/components/frameos_nim (see
# embedded/esp32/build_nim.sh). The firmware drives it through the small
# C API below; pixie does the rendering, the Nim heap lives in PSRAM via
# -d:useMalloc + CONFIG_SPIRAM_USE_MALLOC.
#
# Rendering picks the first available source:
#   1. interpreted scenes loaded through fos_nim_load_scenes (QuickJS + the
#      AOT app library, hot-updatable from the backend without reflashing)
#   2. the baked demo scene in embedded_scene.nim

import std/[math, monotimes, options, strformat, times]
import pixie

import embedded_scene
import embedded_runtime
import frameos/utils/dither
import frameos/utils/image as frameos_image
import frameos/utils/memory

# `log` comes from embedded_runtime (same frameos_nim_log_hook C hook).

# ------------------------------------------------------------------- state

var
  frameWidth = 0
  frameHeight = 0
  frameName = ""
  renderCount = 0
  lastRenderMs = 0
  infoBuffer: string
  sceneInfoBuffer: string
  sceneStateBuffer: string

# --------------------------------------------------------- out-of-memory
# The patched allocator (src/embedded/patched_malloc.nim via config.nims)
# survives a failed allocation by releasing a 1MB PSRAM reserve
# (frameos_nim_glue.c) and retrying. After each render we check whether the
# reserve was consumed, shed memory and re-arm it, so a single oversized
# frame degrades instead of rebooting the device.

proc armEmergencyReserve() {.importc: "fos_nim_arm_emergency_reserve", cdecl.}
proc emergencyReserveUsed(): bool {.importc: "fos_nim_emergency_reserve_used", cdecl.}

proc recoverEmergencyReserve(where: string) =
  if emergencyReserveUsed():
    log("memory pressure: emergency heap reserve was needed during " & where &
        "; collecting and re-arming")
    GC_fullCollect()
    armEmergencyReserve()

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

proc copyPacked(pixels: seq[uint8]; buf: ptr UncheckedArray[uint8]; bufLen: int): bool =
  if pixels.len != bufLen:
    log(&"pack: buffer mismatch, want {pixels.len} bytes, got {bufLen}")
    return false
  for i in 0 ..< bufLen:
    buf[i] = pixels[i]
  true

proc grayLevel(value: float32; maxValue: uint8): uint8 {.inline.} =
  let rounded = round(value).int
  if rounded < 0:
    return 0
  if rounded > maxValue.int:
    return maxValue
  rounded.uint8

proc clip8(value: int): uint8 {.inline.} =
  if value < 0:
    return 0
  if value > 255:
    return 255
  value.uint8

proc packImageGray(image: Image; buf: ptr UncheckedArray[uint8]; bufLen: int; maxValue: uint8): bool =
  let
    width = image.width
    height = image.height
    pixelsPerByte = if maxValue <= 3: 4 else: 2
    bits = if maxValue <= 3: 2 else: 4
    rowBytes = (width + pixelsPerByte - 1) div pixelsPerByte
  if rowBytes * height != bufLen:
    log(&"pack gray: buffer mismatch, want {rowBytes * height} bytes, got {bufLen}")
    return false

  var
    gray = newSeq[float](width * height)
  image.toGrayscaleFloat(gray, maxValue.float)
  gray.floydSteinberg(width, height)

  for i in 0 ..< bufLen:
    buf[i] = 0
  for y in 0 ..< height:
    for x in 0 ..< width:
      let
        inputIndex = y * width + x
        outIndex = y * rowBytes + x div pixelsPerByte
        level = grayLevel(gray[inputIndex].float32, maxValue)
      if bits == 2:
        buf[outIndex] = buf[outIndex] or ((level and 0b11'u8) shl (6 - (x mod 4) * 2))
      else:
        buf[outIndex] = buf[outIndex] or ((level and 0x0F'u8) shl (if (x mod 2) == 0: 4 else: 0))
  true

proc packImageDual1bpp(
    image: Image;
    buf: ptr UncheckedArray[uint8];
    bufLen: int;
    accentIsRed: bool
  ): bool =
  let
    width = image.width
    height = image.height
    inputRowBytes = (width + 3) div 4
    packedRowBytes = (width + 7) div 8
    planeBytes = packedRowBytes * height
  if planeBytes * 2 != bufLen:
    log(&"pack dual: buffer mismatch, want {planeBytes * 2} bytes, got {bufLen}")
    return false

  let pixels = ditherPaletteIndexed(image, @[(0, 0, 0), (255, if accentIsRed: 0 else: 255, 0), (255, 255, 255)])
  for i in 0 ..< bufLen:
    buf[i] = 0

  for y in 0 ..< height:
    for x in 0 ..< width:
      let
        pixelByte = pixels[y * inputRowBytes + x div 4]
        pixelValue = (pixelByte shr ((3 - x mod 4) * 2)) and 0b11
        black: uint8 = if pixelValue == 0: 0'u8 else: 1'u8
        accent: uint8 = if pixelValue == 1: 0'u8 else: 1'u8
        outputIndex = y * packedRowBytes + x div 8
        shift = 7 - (x mod 8)
      buf[outputIndex] = buf[outputIndex] or (black shl shift)
      buf[planeBytes + outputIndex] = buf[planeBytes + outputIndex] or (accent shl shift)
  true

proc packImagePalette(
    image: Image;
    buf: ptr UncheckedArray[uint8];
    bufLen: int;
    palette: seq[(int, int, int)]
  ): bool =
  let
    width = image.width
    height = image.height
    bits = if palette.len <= 2: 1 elif palette.len <= 4: 2 elif palette.len <= 16: 4 else: 8
    pixelsPerByte = if palette.len <= 2: 8 elif palette.len <= 4: 4 elif palette.len <= 16: 2 else: 1
    rowBytes = (width + pixelsPerByte - 1) div pixelsPerByte
    distribution = [7, 3, 5, 1]
    dy = [0, 1, 1, 1]
    dx = [1, -1, 0, 1]

  if rowBytes * height != bufLen:
    log(&"pack palette: buffer mismatch, want {rowBytes * height} bytes, got {bufLen}")
    return false

  for i in 0 ..< bufLen:
    buf[i] = 0

  # Mutate the rendered image in-place while packing. The image is discarded
  # immediately after this step, and avoiding an extra pixie image copy plus a
  # packed output seq keeps ESP32 renders inside PSRAM headroom.
  for y in 0 ..< height:
    for x in 0 ..< width:
      let
        dataIndex = y * width + x
        outputIndex = y * rowBytes + x div pixelsPerByte
        imageR = image.data[dataIndex].r.int
        imageG = image.data[dataIndex].g.int
        imageB = image.data[dataIndex].b.int
        (index, palR, palG, palB) = closestPalette(palette, imageR, imageG, imageB)
        errorR = imageR - palR
        errorG = imageG - palG
        errorB = imageB - palB

      case bits:
      of 8:
        buf[outputIndex] = index.uint8
      of 4:
        let bitPosition = (1 - (x mod 2)) * 4
        buf[outputIndex] = buf[outputIndex] or (index shl bitPosition).uint8
      of 2:
        let bitPosition = (3 - (x mod 4)) * 2
        buf[outputIndex] = buf[outputIndex] or (index shl bitPosition).uint8
      of 1:
        let bitPosition = (7 - x) mod 8
        buf[outputIndex] = buf[outputIndex] or (index shl bitPosition).uint8
      else:
        discard

      for i in 0 ..< 4:
        let
          nextX = x + dx[i]
          nextY = y + dy[i]
        if nextX >= 0 and nextX < width and nextY < height:
          let errorIndex = nextY * width + nextX
          image.data[errorIndex].r = clip8(image.data[errorIndex].r.int + (errorR * distribution[i] div 16))
          image.data[errorIndex].g = clip8(image.data[errorIndex].g.int + (errorG * distribution[i] div 16))
          image.data[errorIndex].b = clip8(image.data[errorIndex].b.int + (errorB * distribution[i] div 16))

  true

proc renderFrameImage(): tuple[image: Image, source: string] =
  let interpreted = renderCurrentScene()
  if interpreted.isSome:
    return (interpreted.get(), "interpreted scene \"" & currentSceneName() & "\"")
  (render(frameWidth, frameHeight, frameName, renderCount + 1), "demo scene")

proc packImageForFormat(
    image: Image;
    buf: ptr UncheckedArray[uint8];
    bufLen: int;
    pixelFormat: int
  ): bool =
  case pixelFormat:
  of 1:
    packImage1bpp(image, buf, bufLen)
  of 2:
    packImageDual1bpp(image, buf, bufLen, true)
  of 3:
    packImageDual1bpp(image, buf, bufLen, false)
  of 4:
    packImageGray(image, buf, bufLen, 3)
  of 5:
    packImagePalette(image, buf, bufLen, saturated4ColorPalette)
  of 6:
    packImagePalette(image, buf, bufLen, saturated7ColorPalette)
  of 7:
    packImagePalette(image, buf, bufLen, spectra6ColorPalette)
  of 8:
    packImageGray(image, buf, bufLen, 15)
  else:
    log(&"pack: unsupported pixel format {pixelFormat}")
    false

proc packedLenForFormat(width, height, pixelFormat: int): int =
  if width <= 0 or height <= 0:
    return 0
  case pixelFormat:
  of 1:
    ((width + 7) div 8) * height
  of 2, 3:
    ((width + 7) div 8) * height * 2
  of 4:
    ((width + 3) div 4) * height
  of 5, 6, 7, 8:
    ((width + 1) div 2) * height
  else:
    0

proc renderBufferAlloc(len: csize_t): pointer {.importc: "frameos_nim_alloc_render_buffer".}
proc renderBufferFree(p: pointer) {.importc: "frameos_nim_free_render_buffer".}

# ------------------------------------------------------------------ C API

proc fos_nim_init_impl(width, height: cint; name: cstring; maxHttpResponseBytes: cint,
    backendUrl: cstring, frameId: cint): bool {.exportc, cdecl.} =
  frameWidth = width.int
  frameHeight = height.int
  frameName = $name
  try:
    armEmergencyReserve()
    let backend =
      if backendUrl == nil or ($backendUrl).len == 0:
        ""
      else:
        $backendUrl
    initRuntime(frameWidth, frameHeight, frameName, maxHttpResponseBytes.int, backend, frameId.int)
    initScene()
    log(&"nim runtime initialized: {frameWidth}x{frameHeight} \"{frameName}\", nim {NimVersion}")
    true
  except Defect as e:
    log("nim init failed (defect): " & e.msg)
    false
  except CatchableError as e:
    log("nim init failed: " & e.msg)
    false

proc fos_nim_load_scenes_impl(payload: cstring): cint {.exportc, cdecl.} =
  ## Install interpreted scenes from JSON (backend scenes.json format).
  ## Returns the number of scenes loaded, 0 on bad payload.
  try:
    result = loadScenes($payload).cint
    recoverEmergencyReserve("scene load")
  except Defect as e:
    log("loadScenes failed (defect): " & e.msg)
    GC_fullCollect()
    recoverEmergencyReserve("scene load failure")
    result = 0
  except CatchableError as e:
    log("loadScenes failed: " & e.msg)
    recoverEmergencyReserve("scene load failure")
    result = 0

proc renderErrorFallback(
    buf: ptr UncheckedArray[uint8];
    bufLen: int;
    pixelFormat: int;
    message: string
  ): cint =
  ## Best-effort error frame after a failed render. Collects first so even
  ## an OOM-aborted render usually has room for one canvas; gives up (keeps
  ## the previous panel contents) when it does not.
  try:
    GC_fullCollect()
    let image = renderError(frameWidth, frameHeight, message)
    if not packImageForFormat(image, buf, bufLen, pixelFormat):
      return 1
    GC_fullCollect()
    0
  except Defect:
    GC_fullCollect()
    1
  except CatchableError:
    GC_fullCollect()
    1

proc fos_nim_render_impl(
    buf: ptr UncheckedArray[uint8];
    bufLen: csize_t;
    pixelFormat: cint
  ): cint {.exportc, cdecl.} =
  try:
    # A render request may be the reason C woke the render task. Clear that
    # stale request before running the scene so only new events raised during
    # this render can schedule another pass.
    discard takeRenderRequested()
    refreshDecodeBudget()
    let start = getMonoTime()
    let rendered = renderFrameImage()
    var image = rendered.image
    let source = rendered.source
    let renderedAt = getMonoTime()
    if not packImageForFormat(image, buf, bufLen.int, pixelFormat.int):
      return 1
    image = nil
    GC_fullCollect()
    let packed = getMonoTime()
    inc renderCount
    lastRenderMs = ((packed - start).inMilliseconds).int
    log(&"render #{renderCount} ({source}, fmt={pixelFormat}): render {(renderedAt - start).inMilliseconds} ms, " &
        &"dither+pack {(packed - renderedAt).inMilliseconds} ms")
    recoverEmergencyReserve("render")
    # Many interpreted scene graphs dispatch "render" while responding to the
    # render event itself. On embedded that should not immediately replay the
    # same frame and fragment the tiny internal heap.
    discard takeRenderRequested()
    result = 0
  except Defect as e:
    log("render failed (defect): " & e.msg)
    result = renderErrorFallback(buf, bufLen.int, pixelFormat.int, "Render failed: " & e.msg)
    recoverEmergencyReserve("render failure")
  except CatchableError as e:
    log("render failed: " & e.msg)
    result = renderErrorFallback(buf, bufLen.int, pixelFormat.int, "Render failed: " & e.msg)
    recoverEmergencyReserve("render failure")

proc renderErrorFallbackAlloc(
    outBuf: var pointer;
    outLen: var csize_t;
    pixelFormat: int;
    message: string
  ): cint =
  ## Error-frame fallback for the allocating render path.
  try:
    GC_fullCollect()
    let packedLen = packedLenForFormat(frameWidth, frameHeight, pixelFormat)
    if packedLen <= 0:
      return 1
    let raw = renderBufferAlloc(packedLen.csize_t)
    if raw == nil:
      return 1
    let image = renderError(frameWidth, frameHeight, message)
    if not packImageForFormat(image, cast[ptr UncheckedArray[uint8]](raw), packedLen, pixelFormat):
      renderBufferFree(raw)
      return 1
    outBuf = raw
    outLen = packedLen.csize_t
    GC_fullCollect()
    0
  except Defect:
    GC_fullCollect()
    1
  except CatchableError:
    GC_fullCollect()
    1

proc fos_nim_render_alloc_impl(
    outBuf: var pointer;
    outLen: var csize_t;
    pixelFormat: cint
  ): cint {.exportc, cdecl.} =
  outBuf = nil
  outLen = 0
  try:
    discard takeRenderRequested()
    refreshDecodeBudget()
    let start = getMonoTime()
    let rendered = renderFrameImage()
    var image = rendered.image
    let source = rendered.source
    let renderedAt = getMonoTime()
    let packedLen = packedLenForFormat(image.width, image.height, pixelFormat.int)
    if packedLen <= 0:
      log(&"pack: unsupported pixel format {pixelFormat}")
      image = nil
      GC_fullCollect()
      return 1
    let raw = renderBufferAlloc(packedLen.csize_t)
    if raw == nil:
      log(&"render failed: out of memory for {packedLen} byte packed framebuffer")
      image = nil
      GC_fullCollect()
      return 1
    let packedBuf = cast[ptr UncheckedArray[uint8]](raw)
    if not packImageForFormat(image, packedBuf, packedLen, pixelFormat.int):
      renderBufferFree(raw)
      image = nil
      GC_fullCollect()
      return 1
    image = nil
    GC_fullCollect()
    let packed = getMonoTime()
    outBuf = raw
    outLen = packedLen.csize_t
    inc renderCount
    lastRenderMs = ((packed - start).inMilliseconds).int
    log(&"render #{renderCount} ({source}, fmt={pixelFormat}): render {(renderedAt - start).inMilliseconds} ms, " &
        &"dither+pack {(packed - renderedAt).inMilliseconds} ms")
    recoverEmergencyReserve("render")
    discard takeRenderRequested()
    result = 0
  except Defect as e:
    log("render failed (defect): " & e.msg)
    if outBuf != nil:
      renderBufferFree(outBuf)
      outBuf = nil
    outLen = 0
    result = renderErrorFallbackAlloc(outBuf, outLen, pixelFormat.int, "Render failed: " & e.msg)
    recoverEmergencyReserve("render failure")
  except CatchableError as e:
    log("render failed: " & e.msg)
    if outBuf != nil:
      renderBufferFree(outBuf)
      outBuf = nil
    outLen = 0
    result = renderErrorFallbackAlloc(outBuf, outLen, pixelFormat.int, "Render failed: " & e.msg)
    recoverEmergencyReserve("render failure")

proc fos_nim_render_1bpp_impl(buf: ptr UncheckedArray[uint8]; bufLen: csize_t): cint {.exportc, cdecl.} =
  fos_nim_render_impl(buf, bufLen, 1)

proc fos_nim_scene_interval_impl(): cdouble {.exportc, cdecl.} =
  ## Refresh interval requested by the active interpreted scene, in seconds;
  ## 0 means "no opinion" (firmware falls back to its configured interval).
  try:
    sceneRefreshSeconds().cdouble
  except Defect as e:
    log("scene interval failed (defect): " & e.msg)
    0.cdouble
  except CatchableError as e:
    log("scene interval failed: " & e.msg)
    0.cdouble

proc fos_nim_render_requested_impl(): bool {.exportc, cdecl.} =
  ## True once when a scene event (e.g. dispatched "render") asked for a
  ## redraw; clears the flag.
  takeRenderRequested()

proc fos_nim_scene_info_json_impl(): cstring {.exportc, cdecl.} =
  try:
    sceneInfoBuffer = sceneInfoJson()
  except Defect as e:
    log("scene info failed (defect): " & e.msg)
    sceneInfoBuffer = "{}"
  except CatchableError as e:
    log("scene info failed: " & e.msg)
    sceneInfoBuffer = "{}"
  sceneInfoBuffer.cstring

proc fos_nim_scene_state_json_impl(): cstring {.exportc, cdecl.} =
  try:
    sceneStateBuffer = sceneStateJson()
  except Defect as e:
    log("scene state failed (defect): " & e.msg)
    sceneStateBuffer = "{}"
  except CatchableError as e:
    log("scene state failed: " & e.msg)
    sceneStateBuffer = "{}"
  sceneStateBuffer.cstring

proc fos_nim_set_scene_impl(sceneId: cstring): bool {.exportc, cdecl.} =
  try:
    if sceneId == nil:
      return false
    result = selectScene($sceneId)
    recoverEmergencyReserve("scene switch")
  except Defect as e:
    log("set scene failed (defect): " & e.msg)
    GC_fullCollect()
    recoverEmergencyReserve("scene switch failure")
    result = false
  except CatchableError as e:
    log("set scene failed: " & e.msg)
    recoverEmergencyReserve("scene switch failure")
    result = false

proc fos_nim_info_impl(): cstring {.exportc, cdecl.} =
  try:
    infoBuffer = &"nim {NimVersion} + pixie + quickjs, {frameWidth}x{frameHeight}, " &
                 &"scenes={sceneCount()}, renders={renderCount}, last={lastRenderMs} ms"
  except Defect, CatchableError:
    infoBuffer = "info unavailable"
  infoBuffer.cstring

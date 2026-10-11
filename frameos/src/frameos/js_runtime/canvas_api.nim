## The drawing surface a pure JS scene (js_scene.nim) renders with.
##
## A `Canvas` object in QuickJS wraps a pixie `Image` the Nim side owns — the
## frame's render canvas, a `cell` (a zero-copy `view` into it), or an
## offscreen image the scene allocated on purpose. Every draw call lands
## straight in that memory:
##
## - arguments are read off the QuickJS stack as numbers and strings, never
##   serialised to JSON (the JS *app* bridge does that; a scene that draws a
##   few hundred shapes per render cannot afford a JSON round trip each);
## - shapes are filled through pixie's solid-paint path, which rasterises
##   coverage row by row and allocates nothing the size of the target;
## - pictures and SVGs decode *into* the rectangle they are drawn in
##   (`readImageIntoTarget`, `downloadImageInto`, `renderSvgIntoTarget`), so a
##   photo costs its compressed body plus decoder rows, not a native-size
##   intermediate;
## - a `cell` is a `view`: a window onto the same pixels that clips every
##   draw to its rectangle, so a dashboard lays itself out without a single
##   full-canvas copy.
##
## The ESP32 canvas is 16-bit (`pfRgb565`) on the largest panels; pixie's
## `setPixel` and the fill kernels branch on the format, so everything here
## works on either. What JS holds is an integer handle id (the QuickJS opaque
## pointer), looked up in `handles`; the class finalizer drops the entry, so
## an image the scene forgot is freed when QuickJS collects the object.
##
## Handles for the render canvas and its cells are *transient*: the Linux
## runner hands out a fresh canvas every render, so after each run
## `finishCanvasRun` invalidates them (and detaches any `pixels()` buffer)
## rather than let a module-level variable keep a dead image alive.

import std/[json, math, os, strutils, tables]
import pixie, chroma, vmath
import frameos/types
import frameos/js_runtime/burrito
import frameos/utils/image
import frameos/utils/font
import frameos/utils/memory
import frameos/utils/text as textUtils

# --------------------------------------------------------------------------
# QuickJS declarations burrito does not wrap: classes, opaque pointers and
# array buffers.
# --------------------------------------------------------------------------

type
  JSClassDef {.importc: "JSClassDef", header: "quickjs/quickjs.h", bycopy.} = object
    class_name: cstring
    finalizer: pointer
    gc_mark: pointer
    call: pointer
    exotic: pointer

{.push importc, header: "quickjs/quickjs.h".}
proc JS_NewClassID(pclass_id: ptr JSClassID): JSClassID
proc JS_NewClass(rt: ptr JSRuntime, class_id: JSClassID, class_def: ptr JSClassDef): cint
proc JS_IsRegisteredClass(rt: ptr JSRuntime, class_id: JSClassID): cint
proc JS_GetRuntime(ctx: ptr JSContext): ptr JSRuntime
proc JS_SetClassProto(ctx: ptr JSContext, class_id: JSClassID, obj: JSValue)
proc JS_GetClassProto(ctx: ptr JSContext, class_id: JSClassID): JSValue
proc JS_NewObjectClass(ctx: ptr JSContext, class_id: cint): JSValue
proc JS_SetOpaque(obj: JSValue, opaque: pointer)
proc JS_GetOpaque(obj: JSValueConst, class_id: JSClassID): pointer
proc JS_NewArrayBuffer(ctx: ptr JSContext, buf: ptr uint8, len: csize_t, free_func: pointer,
    opaque: pointer, is_shared: cint): JSValue
proc JS_DetachArrayBuffer(ctx: ptr JSContext, obj: JSValueConst)
proc JS_GetTypedArrayBuffer(ctx: ptr JSContext, obj: JSValueConst, pbyte_offset: ptr csize_t,
    pbyte_length: ptr csize_t, pbytes_per_element: ptr csize_t): JSValue
proc JS_NewTypedArray(ctx: ptr JSContext, argc: cint, argv: ptr JSValueConst, array_type: cint): JSValue
proc JS_GetArrayBuffer(ctx: ptr JSContext, psize: ptr csize_t, obj: JSValueConst): ptr uint8
{.pop.}

const
  JS_TYPED_ARRAY_UINT8 = 2.cint
  JS_TYPED_ARRAY_UINT16 = 4.cint

# --------------------------------------------------------------------------
# Handles
# --------------------------------------------------------------------------

type
  CanvasHandle* = ref object
    image*: Image
    owned*: bool   ## allocated by the scene (`newImage`); `free()` releases it
    valid*: bool
    frameConfig*: FrameConfig
    logger*: Logger

  CanvasOp = enum
    opClear, opFillRect, opStrokeRect, opFillRoundedRect, opFillCircle, opStrokeCircle,
    opFillEllipse, opLine, opFillPath, opStrokePath, opPolyline, opFillPolygon,
    opText, opMeasureText, opImage, opSvg, opGradient, opCell, opDraw,
    opSetPixel, opGetPixel, opPixels, opFree, opIsValid

var
  canvasClassId: JSClassID = 0
  handles = initTable[int, CanvasHandle]()
  nextHandleId = 0
  ## Handles created for one run (the render canvas and its cells); every
  ## one of them is invalidated when the run ends.
  transientIds: seq[int] = @[]
  ## `pixels()` buffers over canvas memory, detached when the run ends.
  liveBuffers: seq[tuple[ctx: ptr JSContext, buffer: JSValue]] = @[]
  ## One solid paint reused by every fill: a Paint is a ref object pixie
  ## reads and forgets, and a scene draws hundreds of shapes per render.
  solidPaint = newPaint(SolidPaint)

proc handleOf(obj: JSValueConst): CanvasHandle =
  if canvasClassId == 0:
    return nil
  let id = cast[int](JS_GetOpaque(obj, canvasClassId))
  if id == 0 or not handles.hasKey(id):
    return nil
  handles[id]

proc canvasHandleOf*(obj: JSValueConst): CanvasHandle =
  ## The handle behind a JS value, or nil when it is not a Canvas.
  handleOf(obj)

proc canvasFinalizer(rt: ptr JSRuntime, val: JSValue) {.cdecl.} =
  ## QuickJS collected the object: drop the Nim side. An owned image goes
  ## with it; a view just stops referencing its owner.
  try:
    let id = cast[int](JS_GetOpaque(val, canvasClassId))
    if id != 0 and handles.hasKey(id):
      handles.del(id)
  except Exception:
    discard

# --------------------------------------------------------------------------
# Argument helpers — straight off argv, no JSON
# --------------------------------------------------------------------------

template argAt(argv: ptr JSValueConst, i: int): JSValueConst =
  cast[ptr UncheckedArray[JSValueConst]](argv)[i]

proc argFloat(ctx: ptr JSContext, argc: cint, argv: ptr JSValueConst, i: int, default = 0.0): float =
  if i >= argc.int:
    return default
  let v = argAt(argv, i)
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  var res: float64
  if JS_ToFloat64(ctx, addr res, v) != 0:
    raise newException(ValueError, "argument " & $(i + 1) & " must be a number")
  if res != res: # NaN
    return default
  res

proc argString(ctx: ptr JSContext, argc: cint, argv: ptr JSValueConst, i: int, default = ""): string =
  if i >= argc.int:
    return default
  let v = argAt(argv, i)
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  toNimString(ctx, v)

proc argBool(ctx: ptr JSContext, argc: cint, argv: ptr JSValueConst, i: int, default = false): bool =
  if i >= argc.int:
    return default
  let v = argAt(argv, i)
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  JS_ToBool(ctx, v) != 0

proc argObject(argc: cint, argv: ptr JSValueConst, i: int): JSValueConst =
  ## The options object at `i`, or undefined. Not duplicated: valid while
  ## the call runs, which is as long as we read it.
  if i >= argc.int:
    return JSValueConst()
  let v = argAt(argv, i)
  if jsIsObject(v): v else: JSValueConst()

proc optValue(ctx: ptr JSContext, obj: JSValueConst, key: string): JSValue =
  ## A property of an options object; undefined when absent (or no object).
  if not jsIsObject(obj):
    return jsUndefined(ctx)
  JS_GetPropertyStr(ctx, obj, key.cstring)

proc optFloat(ctx: ptr JSContext, obj: JSValueConst, key: string, default: float): float =
  let v = optValue(ctx, obj, key)
  defer: JS_FreeValue(ctx, v)
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  var res: float64
  if JS_ToFloat64(ctx, addr res, v) != 0 or res != res:
    return default
  res

proc optString(ctx: ptr JSContext, obj: JSValueConst, key: string, default: string): string =
  let v = optValue(ctx, obj, key)
  defer: JS_FreeValue(ctx, v)
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  toNimString(ctx, v)

proc optBool(ctx: ptr JSContext, obj: JSValueConst, key: string, default: bool): bool =
  let v = optValue(ctx, obj, key)
  defer: JS_FreeValue(ctx, v)
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  JS_ToBool(ctx, v) != 0

# --------------------------------------------------------------------------
# Colors: "#rgb", "#rrggbb", "#rrggbbaa", any CSS color name, or a number
# 0xRRGGBB (opaque). Numbers are the allocation-free spelling.
# --------------------------------------------------------------------------

proc parseColorText*(text: string, default: Color): Color =
  let s = text.strip()
  if s.len == 0:
    return default
  try:
    if s[0] == '#' and s.len == 9:
      return parseHexAlpha(s[1 .. ^1])
    if s[0] == '#' and s.len == 5:
      let r = s[1] & s[1]
      let g = s[2] & s[2]
      let b = s[3] & s[3]
      let a = s[4] & s[4]
      return parseHexAlpha(r & g & b & a)
    return parseHtmlColor(s)
  except CatchableError:
    return default

proc colorFromValue(ctx: ptr JSContext, v: JSValueConst, default: Color): Color =
  if jsIsUndefined(v) or jsIsNull(v):
    return default
  if jsIsNumber(v):
    var res: float64
    if JS_ToFloat64(ctx, addr res, v) != 0 or res != res:
      return default
    let n = int(res) and 0xFFFFFF
    return color(float32((n shr 16) and 255) / 255, float32((n shr 8) and 255) / 255,
      float32(n and 255) / 255, 1)
  if jsIsString(v):
    return parseColorText(toNimString(ctx, v), default)
  default

proc argColor(ctx: ptr JSContext, argc: cint, argv: ptr JSValueConst, i: int, default: Color): Color =
  if i >= argc.int:
    return default
  colorFromValue(ctx, argAt(argv, i), default)

proc optColor(ctx: ptr JSContext, obj: JSValueConst, key: string, default: Color): Color =
  let v = optValue(ctx, obj, key)
  defer: JS_FreeValue(ctx, v)
  colorFromValue(ctx, v, default)

const
  black = color(0, 0, 0, 1)
  white = color(1, 1, 1, 1)

# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------

type ClipRect = tuple[x, y, w, h: int, ok: bool]

proc clipRect(image: Image, x, y, w, h: float): ClipRect =
  ## The integer rectangle `x,y,w,h` intersected with the image. Negative
  ## sizes and rectangles fully outside come back `ok = false`.
  var x0 = int(floor(x))
  var y0 = int(floor(y))
  var x1 = int(ceil(x + w))
  var y1 = int(ceil(y + h))
  x0 = max(0, x0)
  y0 = max(0, y0)
  x1 = min(image.width, x1)
  y1 = min(image.height, y1)
  if x1 <= x0 or y1 <= y0:
    return (0, 0, 0, 0, false)
  (x0, y0, x1 - x0, y1 - y0, true)

proc isIntegral(v: float): bool =
  abs(v - round(v)) < 0.001

proc setFill(c: Color, blend = NormalBlend) =
  solidPaint.color = c
  solidPaint.opacity = 1
  solidPaint.blendMode = blend

proc transformFrom(ctx: ptr JSContext, opts: JSValueConst, x = 0.0, y = 0.0): Mat3 =
  ## `{x, y, scale, rotate}` on an options object → translate · rotate · scale.
  let tx = optFloat(ctx, opts, "x", x)
  let ty = optFloat(ctx, opts, "y", y)
  let s = optFloat(ctx, opts, "scale", 1.0)
  let rot = optFloat(ctx, opts, "rotate", 0.0)
  result = translate(vec2(tx.float32, ty.float32))
  if rot != 0:
    result = result * rotate(float32(rot * PI / 180))
  if s != 1:
    result = result * scale(vec2(s.float32, s.float32))

proc lineCapFrom(name: string): LineCap =
  case name
  of "round": RoundCap
  of "square": SquareCap
  else: ButtCap

proc lineJoinFrom(name: string): LineJoin =
  case name
  of "round": RoundJoin
  of "bevel": BevelJoin
  else: MiterJoin

proc blendFrom(name: string): BlendMode =
  case name
  of "overwrite": OverwriteBlend
  of "multiply": MultiplyBlend
  of "screen": ScreenBlend
  of "darken": DarkenBlend
  of "lighten": LightenBlend
  of "mask": MaskBlend
  else: NormalBlend

proc hAlignFrom(name: string): HorizontalAlignment =
  case name
  of "center", "middle": CenterAlign
  of "right": RightAlign
  else: LeftAlign

proc vAlignFrom(name: string): VerticalAlignment =
  case name
  of "middle", "center": MiddleAlign
  of "bottom": BottomAlign
  else: TopAlign

proc readPoints(ctx: ptr JSContext, v: JSValueConst, points: var seq[Vec2]) =
  ## `[x0, y0, x1, y1, …]` — a plain array or any typed array. A typed
  ## array is read straight from its buffer; a plain array one element at a
  ## time. Neither path copies the array.
  points.setLen(0)
  if not jsIsObject(v):
    return
  var byteOffset, byteLength, bytesPerElement: csize_t
  let buffer = JS_GetTypedArrayBuffer(ctx, v, addr byteOffset, addr byteLength, addr bytesPerElement)
  if JS_IsException(buffer) == 0:
    defer: JS_FreeValue(ctx, buffer)
    var size: csize_t
    let base = JS_GetArrayBuffer(ctx, addr size, buffer)
    if base != nil and bytesPerElement.int > 0:
      let count = byteLength.int div bytesPerElement.int
      let data = cast[ptr UncheckedArray[uint8]](cast[uint](base) + byteOffset.uint)
      var i = 0
      while i + 1 < count:
        var px, py: float
        case bytesPerElement.int
        of 4:
          px = cast[ptr UncheckedArray[float32]](data)[i].float
          py = cast[ptr UncheckedArray[float32]](data)[i + 1].float
        of 8:
          px = cast[ptr UncheckedArray[float64]](data)[i]
          py = cast[ptr UncheckedArray[float64]](data)[i + 1]
        of 2:
          px = cast[ptr UncheckedArray[int16]](data)[i].float
          py = cast[ptr UncheckedArray[int16]](data)[i + 1].float
        else:
          px = data[i].float
          py = data[i + 1].float
        points.add(vec2(px.float32, py.float32))
        i += 2
    return
  # Not a typed array: the exception is QuickJS saying so.
  let pending = JS_GetException(ctx)
  JS_FreeValue(ctx, pending)
  let count = getArrayLength(ctx, v).int
  var i = 0
  while i + 1 < count:
    let a = JS_GetPropertyUint32(ctx, v, i.uint32)
    let b = JS_GetPropertyUint32(ctx, v, (i + 1).uint32)
    var px, py: float64
    discard JS_ToFloat64(ctx, addr px, a)
    discard JS_ToFloat64(ctx, addr py, b)
    JS_FreeValue(ctx, a)
    JS_FreeValue(ctx, b)
    points.add(vec2(px.float32, py.float32))
    i += 2

# --------------------------------------------------------------------------
# Object creation
# --------------------------------------------------------------------------

proc canvasMethod(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst,
    magic: cint): JSValue {.cdecl.}

const canvasMethods = [
  (opClear, "clear", 1), (opFillRect, "fillRect", 5), (opStrokeRect, "strokeRect", 6),
  (opFillRoundedRect, "fillRoundedRect", 6), (opFillCircle, "fillCircle", 4),
  (opStrokeCircle, "strokeCircle", 5), (opFillEllipse, "fillEllipse", 5), (opLine, "line", 6),
  (opFillPath, "fillPath", 3), (opStrokePath, "strokePath", 4), (opPolyline, "polyline", 4),
  (opFillPolygon, "fillPolygon", 2), (opText, "text", 4), (opMeasureText, "measureText", 2),
  (opImage, "image", 2), (opSvg, "svg", 2), (opGradient, "gradient", 5), (opCell, "cell", 4),
  (opDraw, "draw", 4), (opSetPixel, "setPixel", 3), (opGetPixel, "getPixel", 2),
  (opPixels, "pixels", 0), (opFree, "free", 0), (opIsValid, "isValid", 0),
]

proc ensureCanvasClass(ctx: ptr JSContext) =
  if canvasClassId == 0:
    discard JS_NewClassID(addr canvasClassId)
  let rt = JS_GetRuntime(ctx)
  if JS_IsRegisteredClass(rt, canvasClassId) == 0:
    var def: JSClassDef
    def.class_name = "Canvas"
    def.finalizer = cast[pointer](canvasFinalizer)
    discard JS_NewClass(rt, canvasClassId, addr def)
  let existing = JS_GetClassProto(ctx, canvasClassId)
  if jsIsObject(existing):
    JS_FreeValue(ctx, existing)
    return
  JS_FreeValue(ctx, existing)
  let proto = JS_NewObject(ctx)
  for (op, name, nargs) in canvasMethods:
    let fn = JS_NewCFunctionMagic(ctx, canvasMethod, name.cstring, nargs.cint, JS_CFUNC_generic_magic, op.cint)
    discard JS_DefinePropertyValueStr(ctx, proto, name.cstring, fn, JS_PROP_WRITABLE or JS_PROP_CONFIGURABLE)
  JS_SetClassProto(ctx, canvasClassId, proto)

proc newCanvasObject*(ctx: ptr JSContext, image: Image, frameConfig: FrameConfig, logger: Logger,
    owned: bool, transient: bool): JSValue =
  ## A Canvas object over `image`. `owned` images are the scene's to free;
  ## `transient` ones (the render canvas, its cells) die with the run.
  ensureCanvasClass(ctx)
  inc nextHandleId
  let id = nextHandleId
  handles[id] = CanvasHandle(image: image, owned: owned, valid: true, frameConfig: frameConfig, logger: logger)
  if transient:
    transientIds.add(id)
  result = JS_NewObjectClass(ctx, canvasClassId.cint)
  JS_SetOpaque(result, cast[pointer](id))
  discard JS_DefinePropertyValueStr(ctx, result, "width", nimIntToJS(ctx, image.width.int32), JS_PROP_ENUMERABLE)
  discard JS_DefinePropertyValueStr(ctx, result, "height", nimIntToJS(ctx, image.height.int32), JS_PROP_ENUMERABLE)
  discard JS_DefinePropertyValueStr(ctx, result, "format",
    nimStringToJS(ctx, if image.isRgb565: "rgb565" else: "rgbx"), JS_PROP_ENUMERABLE)

proc finishCanvasRun*(ctx: ptr JSContext) =
  ## The run is over: the render canvas and its cells are no longer the
  ## scene's to draw on, and no `pixels()` view may outlive the memory it
  ## points at.
  for id in transientIds:
    if handles.hasKey(id):
      let handle = handles[id]
      handle.valid = false
      handle.image = nil
  transientIds.setLen(0)
  var keep: seq[tuple[ctx: ptr JSContext, buffer: JSValue]] = @[]
  for entry in liveBuffers:
    if entry.ctx == ctx:
      JS_DetachArrayBuffer(entry.ctx, entry.buffer)
      JS_FreeValue(entry.ctx, entry.buffer)
    else:
      keep.add(entry)
  liveBuffers = keep

proc dropCanvasBuffersFor*(ctx: ptr JSContext) =
  ## The context is closing: forget its buffers without touching it.
  var keep: seq[tuple[ctx: ptr JSContext, buffer: JSValue]] = @[]
  for entry in liveBuffers:
    if entry.ctx != ctx:
      keep.add(entry)
  liveBuffers = keep

proc liveCanvasHandleCount*(): int =
  ## For tests: how many handles QuickJS has not collected yet.
  handles.len

proc allocateSceneImage*(width, height: int): Image =
  ## An offscreen RGBX image for a scene, refused when the frame cannot
  ## afford it: on an ESP32 an allocation the heap cannot satisfy is not a
  ## catchable failure, so ask first.
  if width <= 0 or height <= 0:
    raise newException(ValueError, "image size must be positive")
  if width > 8192 or height > 8192:
    raise newException(ValueError, "image size is too large")
  let bytes = width.int64 * height.int64 * 4
  when defined(frameosEmbedded):
    let available = availableRenderBytes()
    if available > 0 and bytes > available:
      raise newException(ValueError, "out of memory: a " & $width & "x" & $height &
        " image needs " & $(bytes div 1024) & " KB, " & $(available div 1024) & " KB free")
  else:
    if bytes > 512 * 1024 * 1024:
      raise newException(ValueError, "image size is too large")
  newImage(width, height)

# --------------------------------------------------------------------------
# Asset paths
# --------------------------------------------------------------------------

proc resolveAssetPath(handle: CanvasHandle, relPath: string): string =
  ## A path under the frame's assets folder; nothing climbs out of it.
  let root = if handle.frameConfig.isNil: "" else: handle.frameConfig.assetsPath
  if root.len == 0:
    raise newException(ValueError, "assets folder is not configured")
  var rel = relPath.strip()
  if rel.startsWith("assets/"):
    rel = rel[7 .. ^1]
  if rel.len == 0 or rel.isAbsolute or rel.contains("..") or rel.contains('\\'):
    raise newException(ValueError, "invalid asset path: " & relPath)
  root / rel

proc logError(handle: CanvasHandle, event: string, message: string, extra: JsonNode = nil) =
  if handle.logger.isNil or handle.logger.log.isNil:
    return
  var payload = %*{"event": event, "error": message}
  if not extra.isNil and extra.kind == JObject:
    for key, value in extra.pairs:
      payload[key] = value
  handle.logger.log(payload)

# --------------------------------------------------------------------------
# The operations
# --------------------------------------------------------------------------

proc fillRectOp(image: Image, x, y, w, h: float, c: Color) =
  ## Axis-aligned opaque integer rects are the common case (backgrounds,
  ## boxes, bars): fill the rows directly. Everything else is a path.
  if w <= 0 or h <= 0:
    return
  if c.a >= 1 and isIntegral(x) and isIntegral(y) and isIntegral(w) and isIntegral(h):
    let r = clipRect(image, round(x), round(y), round(w), round(h))
    if r.ok:
      image.view(r.x, r.y, r.w, r.h).fill(c)
    return
  let path = newPath()
  path.rect(x.float32, y.float32, w.float32, h.float32)
  setFill(c)
  image.fillPath(path, solidPaint)

proc strokeShape(image: Image, path: Path, c: Color, width: float, transform = mat3(),
    cap = ButtCap, join = MiterJoin, dashes: seq[float32] = @[]) =
  if width <= 0:
    return
  setFill(c)
  image.strokePath(path, solidPaint, transform, width.float32, cap, join, dashes = dashes)

proc fillShape(image: Image, path: Path, c: Color, transform = mat3(), blend = NormalBlend) =
  setFill(c, blend)
  image.fillPath(path, solidPaint, transform)

proc drawGradient(image: Image, x, y, w, h: float, stops: seq[Color], angleDeg: float) =
  ## A linear gradient written pixel by pixel in the target's own format: no
  ## mask, no paint image, no strips. `angle` follows CSS: 180 is top to
  ## bottom, 90 left to right.
  let r = clipRect(image, x, y, w, h)
  if not r.ok or stops.len == 0:
    return
  if stops.len == 1:
    image.view(r.x, r.y, r.w, r.h).fill(stops[0])
    return
  let a = angleDeg * PI / 180
  let dx = sin(a)
  let dy = -cos(a)
  let cx = x + w / 2
  let cy = y + h / 2
  let length = abs(w * dx) + abs(h * dy)
  if length <= 0:
    return
  let segments = stops.len - 1
  for py in r.y ..< r.y + r.h:
    let fy = py.float + 0.5 - cy
    var idx = image.dataIndex(r.x, py)
    for px in r.x ..< r.x + r.w:
      let fx = px.float + 0.5 - cx
      var t = (fx * dx + fy * dy) / length + 0.5
      t = clamp(t, 0.0, 1.0)
      let pos = t * segments.float
      let i = min(segments - 1, int(pos))
      let f = (pos - i.float).float32
      let c0 = stops[i]
      let c1 = stops[i + 1]
      let c = color(c0.r + (c1.r - c0.r) * f, c0.g + (c1.g - c0.g) * f,
        c0.b + (c1.b - c0.b) * f, c0.a + (c1.a - c0.a) * f)
      image.setPixel(idx, c.rgbx)
      inc idx

proc textOp(ctx: ptr JSContext, handle: CanvasHandle, argc: cint, argv: ptr JSValueConst,
    draw: bool): JSValue =
  ## text(text, x, y, opts) / measureText(text, opts).
  let image = handle.image
  let text = argString(ctx, argc, argv, 0)
  var x = 0.0
  var y = 0.0
  var opts: JSValueConst
  if draw:
    x = argFloat(ctx, argc, argv, 1)
    y = argFloat(ctx, argc, argv, 2)
    opts = argObject(argc, argv, 3)
  else:
    opts = argObject(argc, argv, 1)
  let fontName = optString(ctx, opts, "font", "")
  let size = optFloat(ctx, opts, "size", 24)
  let c = optColor(ctx, opts, "color", black)
  let width = optFloat(ctx, opts, "width", 0)
  let height = optFloat(ctx, opts, "height", 0)
  let hAlign = hAlignFrom(optString(ctx, opts, "align", "left"))
  let vAlign = vAlignFrom(optString(ctx, opts, "valign", "top"))
  let wrap = optBool(ctx, opts, "wrap", true)
  let fit = optBool(ctx, opts, "fit", false)
  let lineHeight = optFloat(ctx, opts, "lineHeight", 0)
  let assetsPath = if handle.frameConfig.isNil: "" else: handle.frameConfig.assetsPath
  var measured: Vec2
  if fit and width > 0 and height > 0:
    # Shrink until it fits the box: the shared binary search every text app
    # uses, so a headline that is too long for its cell gets smaller instead
    # of spilling.
    let layout = textUtils.typesetIntoBounds(textUtils.TextRenderOptions(
      text: text, richTextMode: "disabled",
      position: (case hAlign
        of CenterAlign: "center"
        of RightAlign: "right"
        else: "left"),
      vAlign: (case vAlign
        of MiddleAlign: "middle"
        of BottomAlign: "bottom"
        else: "top"),
      padding: 0, font: fontName, fontColor: c, fontSize: size, borderWidth: 0,
      overflow: "fit-bounds", assetsPath: assetsPath), int(width), int(height))
    measured = layoutBounds(layout.textTypeset)
    if draw:
      image.fillText(layout.textTypeset, translate(vec2(x.float32, y.float32)))
  else:
    let typeface = getTypeface(fontName, assetsPath)
    let font = newFont(typeface, size, c)
    if lineHeight > 0:
      font.lineHeight = lineHeight.float32
    font.underline = optBool(ctx, opts, "underline", false)
    font.strikethrough = optBool(ctx, opts, "strikethrough", false)
    let bounds = vec2(width.float32, height.float32)
    let arrangement = font.typeset(text, bounds, hAlign, vAlign, wrap)
    measured = layoutBounds(arrangement)
    if draw:
      image.fillText(arrangement, translate(vec2(x.float32, y.float32)))
  result = JS_NewObject(ctx)
  discard JS_SetPropertyStr(ctx, result, "width", nimFloatToJS(ctx, measured.x.float))
  discard JS_SetPropertyStr(ctx, result, "height", nimFloatToJS(ctx, measured.y.float))

proc fitModeFrom(name: string): string =
  case name
  of "contain": "contain"
  of "stretch": "stretch"
  of "center": "center"
  else: "cover"

proc scaledFitFrom(mode: string): ScaledDecodeFit =
  case mode
  of "contain", "center": fitContain
  of "stretch": fitStretch
  else: fitCover

proc imageOp(ctx: ptr JSContext, handle: CanvasHandle, argc: cint, argv: ptr JSValueConst): JSValue =
  ## image(source, {x, y, width, height, fit, blend}) → true when drawn.
  ## `source` is a URL, a data URL, a path under the assets folder, or
  ## another Canvas. Decoding lands straight in the target rectangle.
  let image = handle.image
  let opts = argObject(argc, argv, 1)
  let x = optFloat(ctx, opts, "x", 0)
  let y = optFloat(ctx, opts, "y", 0)
  let w = optFloat(ctx, opts, "width", image.width.float - x)
  let h = optFloat(ctx, opts, "height", image.height.float - y)
  let mode = fitModeFrom(optString(ctx, opts, "fit", "cover"))
  let blend = blendFrom(optString(ctx, opts, "blend", "normal"))
  let r = clipRect(image, x, y, w, h)
  if not r.ok:
    return nimBoolToJS(ctx, false)
  let target = image.view(r.x, r.y, r.w, r.h)
  if argc < 1:
    raise newException(ValueError, "image(source) needs a source")
  let source = argAt(argv, 0)
  let other = handleOf(source)
  if not other.isNil:
    if not other.valid or other.image.isNil:
      raise newException(ValueError, "the source canvas is no longer valid")
    if other.image.bufferPointer == image.bufferPointer:
      raise newException(ValueError, "a canvas cannot draw itself")
    scaleAndDrawImage(target, other.image, mode, blendMode = blend)
    return nimBoolToJS(ctx, true)
  let src = argString(ctx, argc, argv, 0)
  if src.len == 0:
    raise newException(ValueError, "image(source) needs a source")
  try:
    if src.startsWith("http://") or src.startsWith("https://") or src.startsWith("data:"):
      let fit = scaledFitFrom(mode)
      let decoded = downloadImageInto(src, target, fit = fit)
      if not decoded.isNil and decoded.bufferPointer != target.bufferPointer:
        # Hosts decode at native size and scale here; the embedded path
        # already drew into the target.
        scaleAndDrawImage(target, decoded, mode, blendMode = blend)
    else:
      let path = handle.resolveAssetPath(src)
      if not fileExists(path):
        raise newException(IOError, "asset not found: " & src)
      if blend != NormalBlend or mode == "center" or not readImageIntoTarget(path, target, mode):
        let decoded = readImageWithDisplayBounds(path)
        scaleAndDrawImage(target, decoded, mode, blendMode = blend)
    return nimBoolToJS(ctx, true)
  except CatchableError as e:
    handle.logError("jsScene:imageError", e.msg, %*{"source": src})
    return nimBoolToJS(ctx, false)

proc svgOp(ctx: ptr JSContext, handle: CanvasHandle, argc: cint, argv: ptr JSValueConst): JSValue =
  ## svg(text, {x, y, width, height}) → true when rasterised. Composites
  ## into the rectangle; the SVG is sized to it.
  let image = handle.image
  let svg = argString(ctx, argc, argv, 0)
  let opts = argObject(argc, argv, 1)
  let x = optFloat(ctx, opts, "x", 0)
  let y = optFloat(ctx, opts, "y", 0)
  let w = optFloat(ctx, opts, "width", image.width.float - x)
  let h = optFloat(ctx, opts, "height", image.height.float - y)
  let r = clipRect(image, x, y, w, h)
  if not r.ok or svg.len == 0:
    return nimBoolToJS(ctx, false)
  let target = image.view(r.x, r.y, r.w, r.h)
  if renderSvgIntoTarget(svg, target):
    return nimBoolToJS(ctx, true)
  handle.logError("jsScene:svgError", svgDecodeError(svg, r.w, r.h))
  nimBoolToJS(ctx, false)

proc pixelsOp(ctx: ptr JSContext, handle: CanvasHandle): JSValue =
  ## A typed array over the canvas memory itself — Uint8Array of
  ## premultiplied RGBA for an RGBX canvas, Uint16Array of packed 5/6/5 for a
  ## 16-bit one. Zero copy, valid for this run only.
  let image = handle.image
  if not image.isContiguous:
    raise newException(ValueError, "pixels() needs a full-width canvas, not a cell")
  let buffer = JS_NewArrayBuffer(ctx, cast[ptr uint8](image.bufferPointer), image.byteSize.csize_t,
    nil, nil, 0)
  if JS_IsException(buffer) != 0:
    return buffer
  liveBuffers.add((ctx, JS_DupValue(ctx, buffer)))
  # The constructor reads (buffer, offset, length) whatever argc says — the
  # JS call path pads the missing ones with undefined, so do the same.
  var argv3 = [JSValueConst(buffer), jsUndefined(ctx), jsUndefined(ctx)]
  result = JS_NewTypedArray(ctx, 3, addr argv3[0], if image.isRgb565: JS_TYPED_ARRAY_UINT16 else: JS_TYPED_ARRAY_UINT8)
  JS_FreeValue(ctx, buffer)

proc dispatchCanvasOp(ctx: ptr JSContext, handle: CanvasHandle, op: CanvasOp, argc: cint,
    argv: ptr JSValueConst): JSValue =
  let image = handle.image
  case op
  of opIsValid:
    return nimBoolToJS(ctx, true)
  of opFree:
    if handle.owned:
      handle.image = nil
      handle.valid = false
    return jsUndefined(ctx)
  of opClear:
    image.fill(argColor(ctx, argc, argv, 0, black))
  of opFillRect:
    fillRectOp(image, argFloat(ctx, argc, argv, 0), argFloat(ctx, argc, argv, 1),
      argFloat(ctx, argc, argv, 2), argFloat(ctx, argc, argv, 3), argColor(ctx, argc, argv, 4, black))
  of opStrokeRect:
    let path = newPath()
    path.rect(argFloat(ctx, argc, argv, 0).float32, argFloat(ctx, argc, argv, 1).float32,
      argFloat(ctx, argc, argv, 2).float32, argFloat(ctx, argc, argv, 3).float32)
    strokeShape(image, path, argColor(ctx, argc, argv, 4, black), argFloat(ctx, argc, argv, 5, 1))
  of opFillRoundedRect:
    let path = newPath()
    let radius = argFloat(ctx, argc, argv, 4).float32
    path.roundedRect(argFloat(ctx, argc, argv, 0).float32, argFloat(ctx, argc, argv, 1).float32,
      argFloat(ctx, argc, argv, 2).float32, argFloat(ctx, argc, argv, 3).float32, radius, radius, radius, radius)
    fillShape(image, path, argColor(ctx, argc, argv, 5, black))
  of opFillCircle:
    let path = newPath()
    path.circle(argFloat(ctx, argc, argv, 0).float32, argFloat(ctx, argc, argv, 1).float32,
      argFloat(ctx, argc, argv, 2).float32)
    fillShape(image, path, argColor(ctx, argc, argv, 3, black))
  of opStrokeCircle:
    let path = newPath()
    path.circle(argFloat(ctx, argc, argv, 0).float32, argFloat(ctx, argc, argv, 1).float32,
      argFloat(ctx, argc, argv, 2).float32)
    strokeShape(image, path, argColor(ctx, argc, argv, 3, black), argFloat(ctx, argc, argv, 4, 1))
  of opFillEllipse:
    let path = newPath()
    path.ellipse(argFloat(ctx, argc, argv, 0).float32, argFloat(ctx, argc, argv, 1).float32,
      argFloat(ctx, argc, argv, 2).float32, argFloat(ctx, argc, argv, 3).float32)
    fillShape(image, path, argColor(ctx, argc, argv, 4, black))
  of opLine:
    let path = newPath()
    path.moveTo(argFloat(ctx, argc, argv, 0).float32, argFloat(ctx, argc, argv, 1).float32)
    path.lineTo(argFloat(ctx, argc, argv, 2).float32, argFloat(ctx, argc, argv, 3).float32)
    let opts = argObject(argc, argv, 6)
    strokeShape(image, path, argColor(ctx, argc, argv, 4, black), argFloat(ctx, argc, argv, 5, 1),
      cap = lineCapFrom(optString(ctx, opts, "cap", "butt")))
  of opFillPath:
    # fillPath(d, color, {x, y, scale, rotate, evenOdd})
    let d = argString(ctx, argc, argv, 0)
    let opts = argObject(argc, argv, 2)
    let path = parsePath(d)
    setFill(argColor(ctx, argc, argv, 1, black), blendFrom(optString(ctx, opts, "blend", "normal")))
    image.fillPath(path, solidPaint, transformFrom(ctx, opts),
      if optBool(ctx, opts, "evenOdd", false): EvenOdd else: NonZero)
  of opStrokePath:
    # strokePath(d, color, width, {x, y, scale, rotate, cap, join, dash})
    let d = argString(ctx, argc, argv, 0)
    let opts = argObject(argc, argv, 3)
    let path = parsePath(d)
    var dashes: seq[float32] = @[]
    let dash = optValue(ctx, opts, "dash")
    if jsIsObject(dash):
      var dashPoints: seq[Vec2]
      readPoints(ctx, dash, dashPoints)
      for p in dashPoints:
        dashes.add(p.x)
        dashes.add(p.y)
    JS_FreeValue(ctx, dash)
    strokeShape(image, path, argColor(ctx, argc, argv, 1, black), argFloat(ctx, argc, argv, 2, 1),
      transformFrom(ctx, opts), lineCapFrom(optString(ctx, opts, "cap", "butt")),
      lineJoinFrom(optString(ctx, opts, "join", "miter")), dashes)
  of opPolyline:
    # polyline(points, color, width, {close, cap, join})
    if argc < 1:
      raise newException(ValueError, "polyline(points) needs points")
    var points: seq[Vec2]
    readPoints(ctx, argAt(argv, 0), points)
    if points.len >= 2:
      let opts = argObject(argc, argv, 3)
      let path = newPath()
      path.moveTo(points[0])
      for i in 1 ..< points.len:
        path.lineTo(points[i])
      if optBool(ctx, opts, "close", false):
        path.closePath()
      strokeShape(image, path, argColor(ctx, argc, argv, 1, black), argFloat(ctx, argc, argv, 2, 1),
        cap = lineCapFrom(optString(ctx, opts, "cap", "butt")),
        join = lineJoinFrom(optString(ctx, opts, "join", "miter")))
  of opFillPolygon:
    if argc < 1:
      raise newException(ValueError, "fillPolygon(points) needs points")
    var points: seq[Vec2]
    readPoints(ctx, argAt(argv, 0), points)
    if points.len >= 3:
      let path = newPath()
      path.moveTo(points[0])
      for i in 1 ..< points.len:
        path.lineTo(points[i])
      path.closePath()
      fillShape(image, path, argColor(ctx, argc, argv, 1, black))
  of opText:
    return textOp(ctx, handle, argc, argv, draw = true)
  of opMeasureText:
    return textOp(ctx, handle, argc, argv, draw = false)
  of opImage:
    return imageOp(ctx, handle, argc, argv)
  of opSvg:
    return svgOp(ctx, handle, argc, argv)
  of opGradient:
    # gradient(x, y, w, h, {from, to, colors, angle})
    let opts = argObject(argc, argv, 4)
    var stops: seq[Color] = @[]
    let colors = optValue(ctx, opts, "colors")
    if jsIsObject(colors):
      let count = getArrayLength(ctx, colors).int
      for i in 0 ..< count:
        let item = JS_GetPropertyUint32(ctx, colors, i.uint32)
        stops.add(colorFromValue(ctx, item, black))
        JS_FreeValue(ctx, item)
    JS_FreeValue(ctx, colors)
    if stops.len == 0:
      stops.add(optColor(ctx, opts, "from", black))
      stops.add(optColor(ctx, opts, "to", white))
    drawGradient(image, argFloat(ctx, argc, argv, 0), argFloat(ctx, argc, argv, 1),
      argFloat(ctx, argc, argv, 2), argFloat(ctx, argc, argv, 3), stops, optFloat(ctx, opts, "angle", 180))
  of opCell:
    let r = clipRect(image, argFloat(ctx, argc, argv, 0), argFloat(ctx, argc, argv, 1),
      argFloat(ctx, argc, argv, 2), argFloat(ctx, argc, argv, 3))
    if not r.ok:
      raise newException(ValueError, "cell() lies outside the canvas")
    return newCanvasObject(ctx, image.view(r.x, r.y, r.w, r.h), handle.frameConfig, handle.logger,
      owned = false, transient = not handle.owned)
  of opDraw:
    # draw(canvas, x, y, {blend, width, height})
    if argc < 1:
      raise newException(ValueError, "draw(canvas) needs a canvas")
    let other = handleOf(argAt(argv, 0))
    if other.isNil or not other.valid or other.image.isNil:
      raise newException(ValueError, "draw() needs a valid canvas")
    if other.image.bufferPointer == image.bufferPointer:
      raise newException(ValueError, "a canvas cannot draw itself")
    let x = argFloat(ctx, argc, argv, 1)
    let y = argFloat(ctx, argc, argv, 2)
    let opts = argObject(argc, argv, 3)
    let blend = blendFrom(optString(ctx, opts, "blend", "normal"))
    let w = optFloat(ctx, opts, "width", 0)
    let h = optFloat(ctx, opts, "height", 0)
    if w > 0 or h > 0:
      let r = clipRect(image, x, y, if w > 0: w else: other.image.width.float,
        if h > 0: h else: other.image.height.float)
      if r.ok:
        scaleAndDrawImage(image.view(r.x, r.y, r.w, r.h), other.image, "stretch", blendMode = blend)
    else:
      image.draw(other.image, translate(vec2(x.float32, y.float32)), blend)
  of opSetPixel:
    let x = int(argFloat(ctx, argc, argv, 0))
    let y = int(argFloat(ctx, argc, argv, 1))
    if x >= 0 and y >= 0 and x < image.width and y < image.height:
      image.setPixel(image.dataIndex(x, y), argColor(ctx, argc, argv, 2, black).rgbx)
  of opGetPixel:
    let x = int(argFloat(ctx, argc, argv, 0))
    let y = int(argFloat(ctx, argc, argv, 1))
    if x >= 0 and y >= 0 and x < image.width and y < image.height:
      let p = image.getPixel(image.dataIndex(x, y))
      return nimIntToJS(ctx, int32((p.r.int shl 16) or (p.g.int shl 8) or p.b.int))
    return nimIntToJS(ctx, 0)
  of opPixels:
    return pixelsOp(ctx, handle)
  jsUndefined(ctx)

proc canvasMethod(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst,
    magic: cint): JSValue {.cdecl.} =
  ## One trampoline for every Canvas method; `magic` is the operation. Time
  ## spent here (a decode, a download) is native time, not the script's.
  let handle = handleOf(thisVal)
  if handle.isNil:
    return JS_ThrowTypeError(ctx, "%s", "not a Canvas".cstring)
  if not handle.valid or handle.image.isNil:
    return JS_ThrowTypeError(ctx, "%s",
      "this canvas is no longer valid: the render it belonged to is over, or it was freed".cstring)
  let guard = guardForContext(ctx)
  enterNativeCall(guard)
  try:
    result = dispatchCanvasOp(ctx, handle, CanvasOp(magic), argc, argv)
  except Exception as e:
    result = JS_ThrowTypeError(ctx, "%s", e.msg.cstring)
  finally:
    leaveNativeCall(guard)

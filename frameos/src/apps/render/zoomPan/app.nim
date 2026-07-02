import json
import math
import strformat
import times
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    inputImage*: Option[Image]
    image*: Image
    motion*: string
    zoomStart*: float
    zoomEnd*: float
    durationSeconds*: float
    easing*: string
    anchor*: string
    phaseStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig
    phaseRestored*: bool
    timeOffset*: float

proc phase*(now: float, durationSeconds: float): float =
  ## Progress through the current cycle, 0..1, wrapping every durationSeconds.
  if durationSeconds <= 0:
    return 0.0
  let cycles = now / durationSeconds
  result = cycles - floor(cycles)

proc cycleIndex*(now: float, durationSeconds: float): int =
  if durationSeconds <= 0:
    return 0
  result = floor(now / durationSeconds).int

proc pingPong*(t: float): float =
  ## Maps 0..1 to 0..1..0 so a wrapping phase produces continuous motion.
  let tc = clamp(t, 0.0, 1.0)
  result = if tc < 0.5: tc * 2.0 else: 2.0 - tc * 2.0

proc eased*(t: float, easing: string): float =
  let tc = clamp(t, 0.0, 1.0)
  case easing
  of "easeInOut":
    result = tc * tc * (3.0 - 2.0 * tc)
  of "sine":
    result = (1.0 - cos(tc * PI)) / 2.0
  else:
    result = tc

proc hash01*(values: varargs[int]): float =
  ## Deterministic FNV-1a hash of the inputs mapped into [0, 1).
  var h = 2166136261'u32
  for value in values:
    var v = cast[uint64](value.int64)
    for _ in 0 ..< 8:
      h = (h xor uint32(v and 0xff'u64)) * 16777619'u32
      v = v shr 8
  result = float(h and 0xffffff'u32) / float(0x1000000)

proc anchorPoint*(anchor: string, seed: int): tuple[x: float, y: float] =
  case anchor
  of "top": (0.5, 0.0)
  of "bottom": (0.5, 1.0)
  of "left": (0.0, 0.5)
  of "right": (1.0, 0.5)
  of "random": (hash01(seed, 11), hash01(seed, 23))
  else: (0.5, 0.5)

proc kenBurnsFocal*(imageW, imageH, seed: int, t: float): tuple[x: float, y: float] =
  ## Focal point drifting from the center area towards a corner picked
  ## deterministically from the image dimensions and the cycle index.
  let corner = int(hash01(imageW, imageH, seed, 101) * 4.0) mod 4
  let cornerX = if corner mod 2 == 0: 0.0 else: 1.0
  let cornerY = if corner < 2: 0.0 else: 1.0
  let jitterX = (hash01(imageW, imageH, seed, 7) - 0.5) * 0.3
  let jitterY = (hash01(imageW, imageH, seed, 13) - 0.5) * 0.3
  let startX = clamp(1.0 - cornerX + jitterX, 0.0, 1.0)
  let startY = clamp(1.0 - cornerY + jitterY, 0.0, 1.0)
  let endX = clamp(cornerX + jitterX, 0.0, 1.0)
  let endY = clamp(cornerY + jitterY, 0.0, 1.0)
  let tc = clamp(t, 0.0, 1.0)
  result = (startX + (endX - startX) * tc, startY + (endY - startY) * tc)

proc zoomAt*(motion: string, zoomStart, zoomEnd, t: float, easing: string): float =
  let startZoom = if zoomStart > 0: zoomStart else: 1.0
  let endZoom = if zoomEnd > 0: zoomEnd else: startZoom
  case motion
  of "zoomIn", "kenBurns":
    result = startZoom + (endZoom - startZoom) * eased(t, easing)
  of "panLeftRight", "panTopBottom":
    result = endZoom
  else: # zoomInOut
    result = startZoom + (endZoom - startZoom) * eased(pingPong(t), easing)

proc cropRect*(imageW, imageH, canvasW, canvasH: int, zoom: float, anchor: string,
    t: float, motion: string, easing: string = "linear", seed: int = 0):
    tuple[x: float, y: float, w: float, h: float] =
  ## Source rect to show at phase t: canvas aspect ratio, never out of bounds,
  ## and at zoom <= 1.0 exactly the largest cover-crop of the image.
  if imageW <= 0 or imageH <= 0 or canvasW <= 0 or canvasH <= 0:
    return (0.0, 0.0, max(imageW, 0).float, max(imageH, 0).float)
  let
    iw = imageW.float
    ih = imageH.float
    canvasAspect = canvasW.float / canvasH.float
  var baseW = iw
  var baseH = iw / canvasAspect
  if baseH > ih:
    baseH = ih
    baseW = ih * canvasAspect
  let effZoom = if zoom > 1.0: zoom else: 1.0
  let w = baseW / effZoom
  let h = baseH / effZoom
  let freeX = iw - w
  let freeY = ih - h
  let tc = clamp(t, 0.0, 1.0)

  var fx = 0.5
  var fy = 0.5
  case motion
  of "panLeftRight":
    fx = eased(pingPong(tc), easing)
    fy = anchorPoint(anchor, seed).y
  of "panTopBottom":
    fx = anchorPoint(anchor, seed).x
    fy = eased(pingPong(tc), easing)
  of "kenBurns":
    (fx, fy) = kenBurnsFocal(imageW, imageH, seed, eased(tc, easing))
  else: # zoomInOut, zoomIn
    (fx, fy) = anchorPoint(anchor, seed)
  result = (freeX * clamp(fx, 0.0, 1.0), freeY * clamp(fy, 0.0, 1.0), w, h)

proc init*(self: App) =
  if self.appConfig.durationSeconds <= 0:
    self.appConfig.durationSeconds = 60.0
  if self.appConfig.zoomStart <= 0:
    self.appConfig.zoomStart = 1.0
  if self.appConfig.zoomEnd <= 0:
    self.appConfig.zoomEnd = self.appConfig.zoomStart

proc clearTransientInputs(self: App) =
  self.appConfig.inputImage = none(Image)
  self.appConfig.image = nil

proc animationCycles(self: App, now: float, durationSeconds: float): float =
  if not self.phaseRestored:
    self.phaseRestored = true
    if self.appConfig.phaseStateKey != "" and not self.scene.isNil and
        not self.scene.state.isNil and self.scene.state.hasKey(self.appConfig.phaseStateKey):
      let persisted = self.scene.state[self.appConfig.phaseStateKey].getFloat()
      self.timeOffset = persisted * durationSeconds - now
  result = (now + self.timeOffset) / durationSeconds

proc renderAt*(self: App, context: ExecutionContext, image: Image, now: float) =
  try:
    let sourceImage = self.appConfig.image
    if sourceImage.isNil:
      raise newException(Exception, "No image provided.")
    if sourceImage == image:
      # The producer already decoded straight into this canvas.
      return
    let durationSeconds = if self.appConfig.durationSeconds > 0:
      self.appConfig.durationSeconds else: 60.0
    let cycles = self.animationCycles(now, durationSeconds)
    let t = cycles - floor(cycles)
    let cycle = floor(cycles).int
    let zoom = zoomAt(self.appConfig.motion, self.appConfig.zoomStart,
        self.appConfig.zoomEnd, t, self.appConfig.easing)
    let (sx, sy, sw, sh) = cropRect(sourceImage.width, sourceImage.height,
        image.width, image.height, zoom, self.appConfig.anchor, t,
        self.appConfig.motion, self.appConfig.easing, cycle)
    if sw <= 0 or sh <= 0:
      raise newException(Exception, "Invalid crop rect.")
    # Sample the source rect straight onto the canvas: pixie's draw()
    # pre-scales whole-source copies for non-integer zooms, which allocates
    # multi-MB intermediates every render and fragments ESP32 PSRAM.
    let stepX = sw / image.width.float
    let stepY = sh / image.height.float
    for y in 0 ..< image.height:
      let srcY = (sy + (y.float + 0.5) * stepY - 0.5).float32
      for x in 0 ..< image.width:
        let srcX = (sx + (x.float + 0.5) * stepX - 0.5).float32
        image.unsafe[x, y] = sourceImage.getRgbaSmooth(srcX, srcY)
    if self.appConfig.phaseStateKey != "":
      self.scene.state[self.appConfig.phaseStateKey] = %*(cycles)
  except Exception as e:
    let message = &"Error rendering zoom & pan: {e.msg}"
    self.logError(message)
    when defined(frameosEmbedded):
      renderErrorInto(image, image.width, image.height, message)
    else:
      let errorImage = renderError(image.width, image.height, message)
      scaleAndDrawImage(image, errorImage, "cover")

proc render*(self: App, context: ExecutionContext, image: Image) =
  renderAt(self, context, image, epochTime())

proc run*(self: App, context: ExecutionContext) =
  try:
    render(self, context, context.image)
  finally:
    self.clearTransientInputs()

proc get*(self: App, context: ExecutionContext): Image =
  try:
    result = if self.appConfig.inputImage.isSome:
      self.appConfig.inputImage.get()
    elif context.hasImage:
      newImage(context.image.width, context.image.height)
    else:
      newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
    render(self, context, result)
  finally:
    self.clearTransientInputs()

import std/math
import pixie
import options
import frameos/apps
import frameos/types
import frameos/utils/app_images

type
  AppConfig* = object
    inputImage*: Option[Image]
    startColor*: Color
    endColor*: Color
    angle*: float

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc angleToPoints*(angle: float, width: float, height: float): seq[Vec2] =
  let rad = angle * PI / 180.0
  let dx = cos(rad)
  let dy = sin(rad)
  let halfDiagonal = sqrt(width * width + height * height) / 2
  let centerX = width / 2
  let centerY = height / 2

  return @[
    vec2(centerX - dx * halfDiagonal, centerY - dy * halfDiagonal),
    vec2(centerX + dx * halfDiagonal, centerY + dy * halfDiagonal)
  ]

when defined(frameosEmbedded):
  # pixie's per-pixel gradient loop is compiled like the rest of the
  # firmware, at -Os with every bounds and range check on: 657 ms for a
  # 480x480 canvas on an ESP32-S3 at 160 MHz (measured 2026-10-25 on the
  # SenseCAP Indicator bench, PR #622), ~450 cycles a pixel; a 13.3" canvas
  # has eight times the pixels. The same fill as pixie's table path (gradientLutSize /
  # gradientLut / lutIndex in pixie/paints.nim: the two-stop ramp sampled
  # at max(1024, 2 * extent) entries, read at the nearest), with t stepped
  # along each row instead of divided out per pixel, checks off and the loop
  # at -O2 like the dither packers. Pixels can land on the neighbouring
  # table entry where pixie's division rounds the other way: a color level
  # at most, the same picture.
  {.pragma: gradientHotLoop, codegenDecl: "__attribute__((optimize(\"O2\"))) $# $#$#".}
else:
  # Built everywhere so the host tests can hold it against pixie's fill;
  # only the firmware uses it.
  {.pragma: gradientHotLoop.}

when true:
  proc fillLinearFast*(image: Image, startColor, endColor: Color, at, to: Vec2) {.gradientHotLoop.} =
    let
      d = to - at
      det = d.x * d.x + d.y * d.y
      extent = sqrt(det)
    var size = 8192
    if extent < 8192'f32:
      size = max(1024, int(extent * 2))
    let last = size - 1
    var lut = newSeq[ColorRGBX](size)
    for i in 0 ..< size:
      lut[i] = mix(startColor, endColor, i.float32 / last.float32).rgbx()
    if det == 0:
      image.fill(lut[0])
      return
    let
      stepX = d.x / det
      pixels = cast[ptr UncheckedArray[ColorRGBX]](image.bufferPointer)
      lastF = last.float32
    {.push boundChecks: off, overflowChecks: off, rangeChecks: off.}
    for y in 0 ..< image.height:
      let rowIndex = image.dataIndex(0, y)
      var t = (d.y * (y.float32 - at.y) + d.x * (0'f32 - at.x)) / det
      for x in 0 ..< image.width:
        let index = if not (t > 0): 0 elif t >= 1: last else: int(t * lastF + 0.5'f32)
        pixels[rowIndex + x] = lut[index]
        t += stepX
    {.pop.}

proc render*(self: App, context: ExecutionContext, image: Image) =
  let handles = angleToPoints(self.appConfig.angle, image.width.toFloat, image.height.toFloat)
  when defined(frameosEmbedded):
    if image.format == pfRgbx and image.width * image.height >= 2048:
      fillLinearFast(image, self.appConfig.startColor, self.appConfig.endColor, handles[0], handles[1])
      return
  let paint = newPaint(LinearGradientPaint)
  paint.gradientStops = @[
    ColorStop(color: self.appConfig.startColor, position: 0),
    ColorStop(color: self.appConfig.endColor, position: 1.0),
  ]
  paint.gradientHandlePositions = handles
  image.fillGradient(paint)

proc run*(self: App, context: ExecutionContext) =
  render(self, context, context.image)

proc get*(self: App, context: ExecutionContext): Image =
  if self.appConfig.inputImage.isSome:
    result = self.appConfig.inputImage.get()
  else:
    # The intoTarget handshake: with both stops declared opaque the gradient
    # overwrites every pixel it fills, so painting the offered target — the
    # live canvas included — is the materialized draw, minus the allocation.
    # The fit is irrelevant to a generator; its output is target-sized.
    let (target, _) = self.takeDecodeTarget(context)
    result = if not target.isNil:
      target
    elif context.hasImage:
      newImage(context.image.width, context.image.height)
    else:
      newImage(self.frameConfig.renderWidth(), self.frameConfig.renderHeight())
  render(self, context, result)


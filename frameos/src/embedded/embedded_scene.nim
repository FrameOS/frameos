# The built-in embedded scene: what a frame shows before interpreted scenes
# have been pushed or loaded.

import std/[strformat, times]
import pixie

const fontData = staticRead("../../assets/copied/fonts/LiberationSans-Regular.ttf")

# Fallback-scene parameters: the backend firmware build extracts these from
# the frame's scene JSON and passes them as -d: defines (see build_nim.sh and
# backend embedded_firmware.py).
const frameosSceneName {.strdefine.}: string = "default"
const frameosSceneBackground {.strdefine.}: string = "#ffffff"

var typeface: Typeface

proc initScene*() =
  typeface = parseTtf(fontData)

proc newFont(size: float32; color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint = newPaint(SolidPaint)
  result.paint.color = color

proc render*(width, height: int; frameName: string; renderCount: int): Image =
  result = newImage(width, height)
  result.fill(try: parseHtmlColor(frameosSceneBackground) except CatchableError: color(1, 1, 1, 1))

  let
    w = width.float32
    h = height.float32
    black = color(0, 0, 0, 1)

  # Border + diagonal pattern strip at the top: dithering/contrast test
  let ctx = newContext(result)
  ctx.strokeStyle = black
  ctx.lineWidth = 4
  ctx.strokeRect(rect(8, 8, w - 16, h - 16))
  for i in 0 ..< 16:
    let shade = 1.0f - i.float32 / 15.0f
    ctx.fillStyle = color(shade, shade, shade, 1)
    ctx.fillRect(rect(24 + i.float32 * (w - 48) / 16, 24, (w - 48) / 16, 40))

  let now = now()
  result.fillText(newFont(min(72, h / 6), black).typeset("FrameOS",
    bounds = vec2(w - 80, 100)), translate(vec2(40, h * 0.22)))
  result.fillText(newFont(min(36, h / 12), black).typeset(
    frameName & "  ·  scene: " & frameosSceneName,
    bounds = vec2(w - 80, 60)), translate(vec2(40, h * 0.40)))
  result.fillText(newFont(min(28, h / 16), black).typeset(
    now.format("yyyy-MM-dd HH:mm:ss") & &"  ·  render #{renderCount}",
    bounds = vec2(w - 80, 50)), translate(vec2(40, h * 0.52)))
  result.fillText(newFont(min(22, h / 20), black).typeset(
    "Rendered on-device by the Nim runtime (pixie on ESP32-S3)",
    bounds = vec2(w - 80, 50)), translate(vec2(40, h * 0.62)))

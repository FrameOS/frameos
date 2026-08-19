# The built-in embedded scene: what a frame shows before interpreted scenes
# have been pushed or loaded.

import std/[strformat, times]
import pixie
import frameos/utils/font as fontUtils

# Fallback-scene parameters: the backend firmware build extracts these from
# the frame's scene JSON and passes them as -d: defines (see build_nim.sh and
# backend embedded_firmware.py).
const frameosSceneName {.strdefine.}: string = "default"
const frameosSceneBackground {.strdefine.}: string = "#ffffff"

proc initScene*() =
  ## Deliberately does nothing but exist.
  ##
  ## This used to parse the default typeface, which is 1.57 MB of PSRAM on an
  ## ESP32-S3 — measured with -d:memProbe, it was the whole of the resident
  ## baseline apart from the 1 MB emergency reserve, and it was paid at boot by
  ## every frame whether or not anything ever drew text. The scene below is
  ## only rendered when no interpreted scene is loaded, and plenty of scenes
  ## (the bundled Weather scene, for one, which draws through SVG) never ask
  ## for a glyph at all.
  ##
  ## getDefaultTypeface already caches behind a lock, so the parse simply
  ## happens on the first piece of text instead of on every boot. Kept as a
  ## no-op rather than removed so the init sequence in embedded_main stays
  ## readable, and so there is somewhere for this explanation to live.
  discard

proc newFont(size: float32; color: Color): Font =
  result = newFont(fontUtils.getDefaultTypeface())
  result.size = size
  result.paint = newPaint(SolidPaint)
  result.paint.color = color

proc renderDemoInto*(canvas: Image; frameName: string; renderCount: int): Image =
  ## Draws the baked demo scene into `canvas` (the persistent canvas) and
  ## returns it.
  result = canvas
  let
    width = result.width
    height = result.height
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

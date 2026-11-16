## Per-image colour profiles: the `<image>.frameos.json` sidecar.
##
## A photo on the assets folder may sit next to a small JSON file that says
## how it should be adjusted before the panel dither sees it: exposure,
## contrast, the black and white points, saturation, a tint per tonal range
## (shadows / midtones / highlights), hue, saturation and luminance per hue
## range, and optionally the palette the dither should quantise this one
## photo against. The editor's "Auto" is a preset that fills the white and
## black points in from the photo's histogram; the runtime only ever applies
## sliders. The editor in
## the Assets panel (`frontend/src/utils/assetColors/`) writes the file and
## previews it with the same arithmetic; `docs/asset-color-profiles.md` is
## the contract for both sides. Keep the two in step: a slider that behaves
## differently on the panel than in the preview is a bug in one of them.
##
## The name is deliberately not dot-prefixed. Every device write path refuses
## hidden names (the cloud hub, the ESP32, the admin upload sanitiser), and
## the file must be writable through the same verbs an image is.
##
## Why it exists: a six-colour Spectra panel's measured white is (178, 193,
## 192). Everything in a photo brighter than that quantises to solid white,
## with the diffused error clipped away — the highlights are flat. Pulling
## the white point down (the editor's Auto preset does it from the photo's
## histogram) puts the texture back; the rest is ordinary grading.

import std/[json, math, options, os, strutils]
import pixie

import ./dither
import ../panel_shape
import ../render_probe


const
  AssetColorSidecarSuffix* = ".frameos.json"
  ## Sidecars are tiny; a bigger file is not one of ours.
  AssetColorSidecarMaxBytes = 65536
  ## Hue range centres, degrees, in the order the sidecar lists them.
  HueRangeNames* = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"]
  HueRangeCentres = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0]
  ## How far the end points travel at ±100: a white point of 1.4 is what a
  ## Spectra panel's white (luminance 0.74) needs to take a photo's full
  ## range, which is what the automatic fit asks for.
  EndPointRange* = 0.4
  # The grey weights the dither uses (utils/dither: toGrayscaleFloat).
  LumR = 0.21
  LumG = 0.72
  LumB = 0.07

type
  ToneRange* = object
    ## -100 .. 100 each. `luminance` lifts or drops the range, the tints
    ## push it towards (or away from) red, green and blue.
    luminance*, r*, g*, b*: float
  HueRange* = object
    ## A hue rotation in degrees (-180 .. 180), then a saturation scale and
    ## a luminance shift (-100 .. 100) for the colors near one hue centre.
    hue*, saturation*, luminance*: float
  AssetColorProfile* = object
    exposure*: float   ## stops, -3 .. 3
    contrast*: float   ## -100 .. 100
    whites*: float     ## -100 .. 100; negative pulls the highlights below the panel's white
    blacks*: float     ## -100 .. 100; positive lifts the shadows
    saturation*: float ## -100 .. 100
    shadows*, midtones*, highlights*: ToneRange
    hues*: array[8, HueRange]
    ## The dither palette for this photo, or empty for the panel's own.
    palette*: seq[(int, int, int)]

proc sidecarPathFor*(imagePath: string): string =
  imagePath & AssetColorSidecarSuffix

proc isSidecarPath*(path: string): bool =
  path.endsWith(AssetColorSidecarSuffix)

proc hasAdjustments*(profile: AssetColorProfile): bool =
  ## Whether applying the profile could change a pixel.
  if profile.exposure != 0 or profile.contrast != 0 or
      profile.whites != 0 or profile.blacks != 0 or profile.saturation != 0:
    return true
  for tone in [profile.shadows, profile.midtones, profile.highlights]:
    if tone.luminance != 0 or tone.r != 0 or tone.g != 0 or tone.b != 0:
      return true
  for hue in profile.hues:
    if hue.hue != 0 or hue.saturation != 0 or hue.luminance != 0:
      return true
  false

proc hasPaletteOverride*(profile: AssetColorProfile): bool =
  profile.palette.len > 0

# ----------------------------------------------------------------- parsing

proc clampSlider(value: float, lo = -100.0, hi = 100.0): float =
  if value != value: 0.0 else: max(lo, min(hi, value))

proc sliderOf(node: JsonNode, key: string, lo = -100.0, hi = 100.0): float =
  if node.isNil or node.kind != JObject or not node.hasKey(key):
    return 0.0
  let value = node[key]
  case value.kind
  of JInt, JFloat: clampSlider(value.getFloat(), lo, hi)
  of JString:
    try:
      clampSlider(parseFloat(value.getStr()), lo, hi)
    except ValueError:
      0.0
  else: 0.0

proc toneOf(node: JsonNode, key: string): ToneRange =
  let tone = if node.isNil or node.kind != JObject: nil else: node{key}
  ToneRange(
    luminance: sliderOf(tone, "luminance"),
    r: sliderOf(tone, "r"),
    g: sliderOf(tone, "g"),
    b: sliderOf(tone, "b"),
  )

proc parseHexColor(text: string): Option[(int, int, int)] =
  var hex = text.strip()
  if hex.startsWith("#"):
    hex = hex[1 ..^ 1]
  if hex.len != 6:
    return none((int, int, int))
  try:
    return some((parseHexInt(hex[0 .. 1]), parseHexInt(hex[2 .. 3]), parseHexInt(hex[4 .. 5])))
  except ValueError:
    return none((int, int, int))

proc parsePalette(node: JsonNode): seq[(int, int, int)] =
  ## `["#rrggbb", …]` or `[[r, g, b], …]`; one bad entry voids the whole
  ## override — the panel's own palette is always a better fallback than a
  ## partial one.
  if node.isNil or node.kind != JArray or node.len == 0:
    return @[]
  for entry in node:
    case entry.kind
    of JString:
      let color = parseHexColor(entry.getStr())
      if color.isNone:
        return @[]
      result.add(color.get())
    of JArray:
      if entry.len != 3:
        return @[]
      var channels: array[3, int]
      for i in 0 .. 2:
        if entry[i].kind notin {JInt, JFloat}:
          return @[]
        channels[i] = max(0, min(255, entry[i].getFloat().round().int))
      result.add((channels[0], channels[1], channels[2]))
    else:
      return @[]

proc parseAssetColorAdjustments*(colors: JsonNode): AssetColorProfile =
  ## The `colors` object alone (the sidecar's inner object, or frame.json's
  ## `colors.global`). Missing keys are neutral; unknown keys are ignored.
  result = AssetColorProfile(
    exposure: sliderOf(colors, "exposure", -3.0, 3.0),
    contrast: sliderOf(colors, "contrast"),
    whites: sliderOf(colors, "whites"),
    blacks: sliderOf(colors, "blacks"),
    saturation: sliderOf(colors, "saturation"),
    shadows: toneOf(colors, "shadows"),
    midtones: toneOf(colors, "midtones"),
    highlights: toneOf(colors, "highlights"),
    palette: parsePalette(if colors.isNil: nil else: colors{"palette"}),
  )
  let hues = if colors.isNil or colors.kind != JObject: nil else: colors{"hues"}
  for i, name in HueRangeNames:
    let hue = if hues.isNil or hues.kind != JObject: nil else: hues{name}
    result.hues[i] = HueRange(
      hue: sliderOf(hue, "hue", -180.0, 180.0),
      saturation: sliderOf(hue, "saturation"),
      luminance: sliderOf(hue, "luminance"),
    )

proc parseAssetColorProfile*(root: JsonNode): Option[AssetColorProfile] =
  ## `{"version": 1, "colors": {...}}`. Unknown keys are ignored, missing
  ## ones are neutral, so an older runtime reads a newer file.
  if root.isNil or root.kind != JObject:
    return none(AssetColorProfile)
  let colors = root{"colors"}
  if colors.isNil or colors.kind != JObject:
    return none(AssetColorProfile)
  some(parseAssetColorAdjustments(colors))

proc loadAssetColorProfile*(imagePath: string): Option[AssetColorProfile] =
  ## The profile next to `imagePath`, or none when there is no sidecar or it
  ## does not parse. Never raises: a broken sidecar must not take the photo
  ## down with it.
  let sidecar = sidecarPathFor(imagePath)
  try:
    if not fileExists(sidecar):
      return none(AssetColorProfile)
    if getFileSize(sidecar) > AssetColorSidecarMaxBytes:
      return none(AssetColorProfile)
    parseAssetColorProfile(parseJson(readFile(sidecar)))
  except CatchableError:
    none(AssetColorProfile)

proc luminance*(r, g, b: float): float {.inline.} =
  LumR * r + LumG * g + LumB * b

# ------------------------------------------------- the per-pixel loops
#
# The automatic fit runs over every pixel an image covers, twice (the
# histogram, then the table), on every render of a palette panel: 1.92 M
# pixels a pass on a 13.3" Spectra. Written the obvious way — `float`
# luminance and `round()` per pixel — that was ~6 µs a pixel on an ESP32-S3,
# whose FPU has no double precision (every `float` op is a soft-float call),
# and the render task on one core for seconds without letting its idle task
# run (the task watchdog; the hardware bench, reTerminal E1004, 2026-11-16).
# Integers alone were not enough: through `getPixel` / `setPixel` each pixel
# was still ~1.2 µs a pass, because the loop's -O2 kept gcc from inlining the
# -Os helpers it called (the 565 expand and pack, the bin, three zeroed
# temporaries), and a raw read of the same canvas took a twentieth of that
# (the E1004 again, measured on the device). So each format gets a loop of
# its own over its buffer, with nothing called per pixel (and no -O2 of its
# own: there is nothing to inline, and it cost flash): a 565 pixel's
# channels go through 32- and 64-entry tables, and its store through tables
# of what pixie's own pack (dithered or not) makes of each level, built per
# fit. A grey canvas keeps the accessors. The bins and the stored pixels are
# the same as before, bit for bit (test_asset_colors.nim compares them).

static:
  # The integer bins below are these weights in hundredths.
  doAssert LumR == 0.21 and LumG == 0.72 and LumB == 0.07

proc tieBin(r, g, b: int): int {.noinline.} =
  ## A sum ending in .50 is decided by the float sum, whose rounding error
  ## can put it on either side, exactly as before.
  max(0, min(255, luminance(r.float, g.float, b.float).round().int))

template binOf(r, g, b: int): int =
  ## `round(luminance(r, g, b))` on 0 .. 255 channels, in integers: the
  ## weights are whole hundredths, so the sum is exact.
  (let hundredths = 21 * r + 72 * g + 7 * b;
   if hundredths mod 100 != 50: (hundredths + 50) div 100 else: tieBin(r, g, b))

proc expandTable(bits: static int): array[1 shl bits, uint8] =
  for v in 0 ..< (1 shl bits):
    result[v] = (if bits == 5: (v shl 3) or (v shr 2) else: (v shl 2) or (v shr 4)).uint8

const
  Expand5 = expandTable(5)
  Expand6 = expandTable(6)

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc luminanceBin*(r, g, b: uint8): int =
  binOf(r.int, g.int, b.int)

proc fitHistogram(image: Image, xStart, yStart, xEnd, yEnd: int,
    histogram: var array[256, int]) =
  let width = xEnd - xStart
  for y in yStart ..< yEnd:
    breathe()
    let rowStart = image.dataIndex(xStart, y)
    case image.format
    of pfRgb565:
      let px = image.data16
      for index in rowStart ..< rowStart + width:
        let p = px[index].int
        inc histogram[binOf(Expand5[p shr 11].int, Expand6[(p shr 5) and 63].int, Expand5[p and 31].int)]
    of pfRgbx:
      let px = image.data
      for index in rowStart ..< rowStart + width:
        inc histogram[binOf(px[index].r.int, px[index].g.int, px[index].b.int)]
    else:
      for index in rowStart ..< rowStart + width:
        let p = image.getPixel(index)
        inc histogram[binOf(p.r.int, p.g.int, p.b.int)]

proc applyLut(image: Image, lut: array[256, uint8], xStart, yStart, xEnd, yEnd: int) =
  let width = xEnd - xStart
  case image.format
  of pfRgb565:
    # What the pack stores for each 5- and 6-bit level, per dither cell (one
    # cell when the stores are not dithered): rgbxToRgb565(Dithered) itself,
    # on a grey of the mapped level, so the result cannot drift from it.
    let cells = if image.ditherStores: 16 else: 1
    var
      at: array[16, int] # an index in each dither cell, -1 until found
      found = 0
      t5: array[16, array[32, uint16]]
      t6: array[16, array[64, uint16]]
    if image.ditherStores:
      for cell in 0 ..< 16:
        at[cell] = -1
      var index = 0
      while found < 16:
        let cell = ((index.uint32 * 0x9E3779B1'u32) shr 28).int
        if at[cell] < 0:
          at[cell] = index
          inc found
        inc index
    for cell in 0 ..< cells:
      template pack(v: uint8): uint16 =
        (let c = rgbx(v, v, v, 255);
         if image.ditherStores: rgbxToRgb565Dithered(c, at[cell]) else: rgbxToRgb565(c))
      for v in 0 ..< 32:
        t5[cell][v] = pack(lut[Expand5[v]]) shr 11
      for v in 0 ..< 64:
        t6[cell][v] = (pack(lut[Expand6[v]]) shr 5) and 63
    let px = image.data16
    let dither = image.ditherStores
    for y in yStart ..< yEnd:
      breathe()
      let rowStart = image.dataIndex(xStart, y)
      for index in rowStart ..< rowStart + width:
        let
          p = px[index].int
          cell = if dither: ((index.uint32 * 0x9E3779B1'u32) shr 28).int else: 0
        px[index] = (t5[cell][p shr 11] shl 11) or (t6[cell][(p shr 5) and 63] shl 5) or t5[cell][p and 31]
  of pfRgbx:
    let px = image.data
    for y in yStart ..< yEnd:
      breathe()
      let rowStart = image.dataIndex(xStart, y)
      for index in rowStart ..< rowStart + width:
        px[index].r = lut[px[index].r]
        px[index].g = lut[px[index].g]
        px[index].b = lut[px[index].b]
  else:
    for y in yStart ..< yEnd:
      breathe()
      let rowStart = image.dataIndex(xStart, y)
      for index in rowStart ..< rowStart + width:
        let p = image.getPixel(index)
        image.setPixel(index, rgbx(lut[p.r], lut[p.g], lut[p.b], p.a))

{.pop.}

proc paletteRange*(palette: seq[(int, int, int)]): tuple[lo, hi: float] =
  ## The darkest and brightest luminance a palette can show, 0 .. 1.
  if palette.len == 0:
    return (0.0, 1.0)
  result = (1.0, 0.0)
  for color in palette:
    if color[0] >= 999:
      continue
    let lum = luminance(color[0].float, color[1].float, color[2].float) / 255.0
    result.lo = min(result.lo, lum)
    result.hi = max(result.hi, lum)
  if result.hi <= result.lo:
    result = (0.0, 1.0)

# ------------------------------------------------------------ panel palette

## The palette the panel dithers to, as far as the host knows it: the Linux
## runner sets it from the device name at boot, the ESP32 from the display
## format at render. The automatic fit aims for its range; empty means "no
## palette" (a full-colour display), where the fit is off by default.
var assetColorsPanelPalette* {.threadvar.}: seq[(int, int, int)]

proc setAssetColorsPanelPalette*(colors: seq[(int, int, int)]) =
  assetColorsPanelPalette = @[]
  for color in colors:
    # The Spectra table's placeholder entry is not a colour.
    if color[0] < 999:
      assetColorsPanelPalette.add(color)

proc panelPaletteForDevice*(device: string, custom: seq[(int, int, int)] = @[]): seq[(int, int, int)] =
  ## The measured palette a device dithers to, as far as the host can tell
  ## without asking the driver: a six-colour custom palette on a Spectra
  ## panel wins (that is what the driver uses too), then the panel family by
  ## its name. Empty for panels the host cannot place — greyscale and
  ## two-colour ones, full-colour displays — where the fit stays off unless
  ## asked for. Mirrors `panelPaletteKindForDevice` in devicePalette.ts.
  let name = device.toLowerAscii()
  let spectra = name.endsWith("e") and (name.contains("13in3e") or name.contains("9in7e") or name.contains("7in3e") or
      name.contains("4in0e") or name.contains("photopainter")) or
    name.contains("inky_impression_4_2025") or name.contains("inky_impression_4_spectra6") or
    name.contains("inky_impression_7_2025") or name.contains("inky_impression_13") or
    name == "pimoroni.inky_impression_7" or name == "pimoroni.inky_impression_4"
  if spectra:
    if custom.len == 6:
      return custom
    result = @[]
    for color in spectra6ColorPalette:
      if color[0] < 999:
        result.add(color)
    return result
  if name.contains("7in3f") or name.contains("5in65f") or name.contains("4in01f") or
      name.contains("inky_impression_4_7_color") or name.contains("inky_impression_5_7") or
      name.contains("inky_impression_7_3") or name == "pimoroni.inky_impression":
    return saturated7ColorPalette
  if name.endsWith("g") and name.startsWith("waveshare.") or name.contains("inky_phat_4") or
      name.contains("inky_what_4"):
    return saturated4ColorPalette
  @[]

proc panelShowsColor*(device: string, canvasFormat: PixelFormat): bool =
  ## Whether the panel shows colors (an LCD, a four-, six- or seven-ink
  ## e-paper), as a scene asks through `app.frame.color`: false on a
  ## black-and-white or grey panel, where the real-time scenes' "auto" draws
  ## in high contrast. An ESP32 (and the preview running as one) says by its
  ## canvas: an LCD's RGB565 and a color e-paper's RGBX, where every grey
  ## and black-and-white panel draws in pixie's grey surfaces. A Pi says by
  ## its device: anything that is not e-paper, or e-paper with a palette. A
  ## control plane drawing for a board says what the board's runtime would
  ## (panel_shape.boardPanelFormat): no color on a grey or black-and-white
  ## panel.
  when defined(frameosWasm):
    if boardPanelFormat > 0:
      return boardPanelFormat notin PanelFormatsGrey
  if canvasFormat == pfRgb565:
    return true
  # A grey canvas shows no color anywhere: the preview running as a grey
  # ESP32 draws in one, as that board does.
  if canvasFormat in {pfGray8, pfGray4}:
    return false
  when defined(frameosEmbedded):
    canvasFormat == pfRgbx
  else:
    let name = device.toLowerAscii()
    let paper = name == "embedded" or name.startsWith("waveshare.") or name.startsWith("inky") or
      name.startsWith("pimoroni.inky")
    not paper or panelPaletteForDevice(device).len >= 4

# ------------------------------------------------------- frame colour rules
#
# frame.json's `colors` block: `{"autoFit": "default" | "on" | "off",
# "global": {<the sidecar's colors object>}}`. The automatic fit runs on
# every image drawn onto the canvas (apps/render/image, the JS runtime) and
# maps the photo's range onto the panel palette's; `default` means on when
# the panel has a palette. The global correction runs once on the finished
# canvas, on every display. Both live in thread-local values the host sets
# from its config (runner.nim per pass, embedded_main per render).

type
  FrameColorSettings* = object
    autoFit*: string ## "default", "on" or "off"
    global*: AssetColorProfile

var frameColorSettings* {.threadvar.}: FrameColorSettings

proc parseFrameColorSettings*(node: JsonNode): FrameColorSettings =
  result = FrameColorSettings(autoFit: "default")
  if node.isNil or node.kind != JObject:
    return
  let mode = node{"autoFit"}.getStr("default")
  result.autoFit = if mode in ["on", "off"]: mode else: "default"
  let global = node{"global"}
  if not global.isNil and global.kind == JObject:
    result.global = parseAssetColorAdjustments(global)
    result.global.palette = @[] # a global correction has no palette of its own

proc setFrameColorSettings*(settings: FrameColorSettings) =
  frameColorSettings = settings

proc autoFitActive*(): bool =
  ## Whether images drawn from now on get the automatic fit.
  case frameColorSettings.autoFit
  of "on": true
  of "off": false
  else: assetColorsPanelPalette.len > 0

# ------------------------------------------------------- the automatic fit

proc autoEndPoints*(image: Image, x0, y0, width, height: int,
    palette: seq[(int, int, int)]): Option[tuple[whites, blacks: float]] =
  ## The Whites and Blacks that map the luminance percentiles 0.5 and 99.5
  ## of one rectangle onto the darkest and brightest luminance of `palette`
  ## — the editor's Auto preset, as the frontend's `autoEndPoints` computes
  ## it, so a saved preset and the frame's own fit agree. None for a flat
  ## rectangle (nothing to fit).
  if image.isNil or width <= 0 or height <= 0:
    return none(tuple[whites, blacks: float])
  let
    xStart = max(0, x0)
    yStart = max(0, y0)
    xEnd = min(image.width, x0 + width)
    yEnd = min(image.height, y0 + height)
  if xEnd <= xStart or yEnd <= yStart:
    return none(tuple[whites, blacks: float])
  var histogram: array[256, int]
  fitHistogram(image, xStart, yStart, xEnd, yEnd, histogram)
  let total = (xEnd - xStart) * (yEnd - yStart)
  let
    loCount = (total.float * 0.005).int
    hiCount = (total.float * 0.995).int
  var
    seen = 0
    lo = 0
    hi = 255
    loFound = false
  for level in 0 .. 255:
    seen += histogram[level]
    if not loFound and seen > loCount:
      lo = level
      loFound = true
    if seen >= hiCount:
      hi = level
      break
  if hi - lo < 3:
    return none(tuple[whites, blacks: float])
  let
    src = (lo: lo.float / 255.0, hi: hi.float / 255.0)
    dst = paletteRange(palette)
    scale = (dst.hi - dst.lo) / (src.hi - src.lo)
    span = 1.0 / scale
    blackPoint = src.lo - dst.lo / scale
    whitePoint = blackPoint + span
  proc clampSlider(value: float): float = max(-100.0, min(100.0, value.round()))
  some((
    whites: clampSlider((1.0 - whitePoint) / EndPointRange * 100.0),
    blacks: clampSlider(-blackPoint / EndPointRange * 100.0),
  ))

# ----------------------------------------------------- graded image marks
#
# A photo whose sidecar the producer already applied must not get the
# automatic fit on top. The producer marks the image it graded; the consumer
# asks before fitting. Weak pointers in a small ring, cleared on a scene
# change: a stale entry can only ever match an image some other app produced
# later at the same address, and all that does is skip one fit.

const GradedImageSlots = 16
var
  gradedImages {.threadvar.}: array[GradedImageSlots, pointer]
  gradedImageNext {.threadvar.}: int

proc markImageGraded*(image: Image) =
  if image.isNil:
    return
  let key = cast[pointer](image)
  for slot in gradedImages:
    if slot == key:
      return
  gradedImages[gradedImageNext] = key
  gradedImageNext = (gradedImageNext + 1) mod GradedImageSlots

proc unmarkImageGraded*(image: Image) =
  if image.isNil:
    return
  let key = cast[pointer](image)
  for i in 0 ..< GradedImageSlots:
    if gradedImages[i] == key:
      gradedImages[i] = nil

proc isImageGraded*(image: Image): bool =
  if image.isNil:
    return false
  let key = cast[pointer](image)
  for slot in gradedImages:
    if slot == key:
      return true
  false

proc clearGradedImages*() =
  for i in 0 ..< GradedImageSlots:
    gradedImages[i] = nil
  gradedImageNext = 0

# --------------------------------------------------------------- the maths
#
# Mirrored line for line by frontend/src/utils/assetColors/adjust.ts. The
# order is the order a photographer expects to reason about: exposure, the
# end points, contrast, the tonal tints, saturation, then the per-hue
# corrections.

proc clamp01(value: float): float {.inline.} =
  if value < 0.0: 0.0 elif value > 1.0: 1.0 else: value

proc hueWeights(hue: float): array[8, float] =
  ## Piecewise-linear interpolation between neighbouring hue centres, so a
  ## hue between red (0°) and orange (30°) is partly both and the weights
  ## always sum to one.
  var h = hue mod 360.0
  if h < 0: h += 360.0
  for i in 0 ..< 8:
    let
      c0 = HueRangeCentres[i]
      c1 = if i == 7: 360.0 else: HueRangeCentres[i + 1]
    if h >= c0 and h < c1:
      let t = (h - c0) / (c1 - c0)
      result[i] = 1.0 - t
      result[if i == 7: 0 else: i + 1] = t
      return

proc rgbToHsl(r, g, b: float): tuple[h, s, l: float] =
  let
    maxC = max(r, max(g, b))
    minC = min(r, min(g, b))
    delta = maxC - minC
  result.l = (maxC + minC) / 2.0
  if delta <= 0.0:
    return (0.0, 0.0, result.l)
  result.s = if result.l > 0.5: delta / (2.0 - maxC - minC) else: delta / (maxC + minC)
  var h =
    if maxC == r: (g - b) / delta + (if g < b: 6.0 else: 0.0)
    elif maxC == g: (b - r) / delta + 2.0
    else: (r - g) / delta + 4.0
  h = h * 60.0
  if h >= 360.0: h -= 360.0
  result.h = h

proc hueToRgb(p, q, t: float): float =
  var t = t
  if t < 0.0: t += 1.0
  if t > 1.0: t -= 1.0
  if t < 1.0 / 6.0: return p + (q - p) * 6.0 * t
  if t < 0.5: return q
  if t < 2.0 / 3.0: return p + (q - p) * (2.0 / 3.0 - t) * 6.0
  p

proc hslToRgb(h, s, l: float): tuple[r, g, b: float] =
  if s <= 0.0:
    return (l, l, l)
  let
    q = if l < 0.5: l * (1.0 + s) else: l + s - l * s
    p = 2.0 * l - q
    hk = h / 360.0
  (hueToRgb(p, q, hk + 1.0 / 3.0), hueToRgb(p, q, hk), hueToRgb(p, q, hk - 1.0 / 3.0))

proc adjustPixel*(profile: AssetColorProfile, r0, g0, b0: float): tuple[r, g, b: float] =
  ## One pixel, channels 0 .. 1 in and out.
  var
    r = r0
    g = g0
    b = b0
  if profile.exposure != 0:
    let gain = pow(2.0, profile.exposure)
    r *= gain
    g *= gain
    b *= gain
  if profile.blacks != 0 or profile.whites != 0:
    let
      blackPoint = -profile.blacks / 100.0 * EndPointRange
      whitePoint = 1.0 - profile.whites / 100.0 * EndPointRange
      span = max(whitePoint - blackPoint, 0.2)
    r = (r - blackPoint) / span
    g = (g - blackPoint) / span
    b = (b - blackPoint) / span
  if profile.contrast != 0:
    let factor = max(1.0 + profile.contrast / 100.0, 0.0)
    r = (r - 0.5) * factor + 0.5
    g = (g - 0.5) * factor + 0.5
    b = (b - 0.5) * factor + 0.5
  r = clamp01(r)
  g = clamp01(g)
  b = clamp01(b)
  block tones:
    let
      lum = luminance(r, g, b)
      wShadows = (1.0 - lum) * (1.0 - lum)
      wHighlights = lum * lum
      wMidtones = 1.0 - wShadows - wHighlights
    for pair in [(wShadows, profile.shadows), (wMidtones, profile.midtones), (wHighlights, profile.highlights)]:
      let (weight, tone) = pair
      if tone.luminance == 0 and tone.r == 0 and tone.g == 0 and tone.b == 0:
        continue
      let lift = weight * tone.luminance / 100.0 * 0.5
      r += lift + weight * tone.r / 100.0 * 0.35
      g += lift + weight * tone.g / 100.0 * 0.35
      b += lift + weight * tone.b / 100.0 * 0.35
    r = clamp01(r)
    g = clamp01(g)
    b = clamp01(b)
  if profile.saturation != 0:
    let
      lum = luminance(r, g, b)
      factor = max(1.0 + profile.saturation / 100.0, 0.0)
    r = clamp01(lum + (r - lum) * factor)
    g = clamp01(lum + (g - lum) * factor)
    b = clamp01(lum + (b - lum) * factor)
  block hues:
    var anyHue = false
    for hue in profile.hues:
      if hue.hue != 0 or hue.saturation != 0 or hue.luminance != 0:
        anyHue = true
        break
    if not anyHue:
      break hues
    let hsl = rgbToHsl(r, g, b)
    if hsl.s <= 0.001:
      break hues
    let weights = hueWeights(hsl.h)
    var
      hueShift = 0.0
      satScale = 0.0
      lumShift = 0.0
    for i in 0 ..< 8:
      if weights[i] == 0.0:
        continue
      hueShift += weights[i] * profile.hues[i].hue
      satScale += weights[i] * profile.hues[i].saturation / 100.0
      lumShift += weights[i] * profile.hues[i].luminance / 100.0
    let
      h = hsl.h + hueShift
      s = clamp01(hsl.s * max(1.0 + satScale, 0.0))
      # Luminance moves only coloured pixels: a grey has no hue to belong to.
      l = clamp01(hsl.l + lumShift * 0.3 * hsl.s)
    let rgb = hslToRgb(h, s, l)
    r = clamp01(rgb.r)
    g = clamp01(rgb.g)
    b = clamp01(rgb.b)
  (r, g, b)

proc isLinearProfile*(profile: AssetColorProfile): bool =
  ## Only the per-channel steps (exposure, the end points, contrast): the
  ## same map for every channel, so a 256-entry table replaces the float
  ## pipeline. The automatic fit is always linear.
  if profile.saturation != 0:
    return false
  for tone in [profile.shadows, profile.midtones, profile.highlights]:
    if tone.luminance != 0 or tone.r != 0 or tone.g != 0 or tone.b != 0:
      return false
  for hue in profile.hues:
    if hue.hue != 0 or hue.saturation != 0 or hue.luminance != 0:
      return false
  true

proc linearLut*(profile: AssetColorProfile): array[256, uint8] =
  ## The 8-bit map a linear profile is: `adjustPixel` evaluated once per
  ## level, so the two never disagree.
  for level in 0 .. 255:
    let v = level.float / 255.0
    let adjusted = adjustPixel(profile, v, v, v)
    result[level] = uint8(max(0.0, min(255.0, (adjusted.r * 255.0).round())))

proc applyAssetColors*(image: Image, profile: AssetColorProfile,
    x0 = 0, y0 = 0, width = -1, height = -1) =
  ## Adjusts every pixel of `image` — or of one rectangle of it, for an image
  ## decoded straight into the render canvas that only owns the fitted part —
  ## in place. Alpha is kept; the colors are taken as straight (a photo has
  ## no transparency to speak of).
  if image.isNil or image.width <= 0 or image.height <= 0 or not profile.hasAdjustments():
    return
  let
    xStart = max(0, x0)
    yStart = max(0, y0)
    xEnd = if width < 0: image.width else: min(image.width, x0 + width)
    yEnd = if height < 0: image.height else: min(image.height, y0 + height)
  if xEnd <= xStart or yEnd <= yStart:
    return
  if profile.isLinearProfile():
    # Three table lookups per pixel: what makes the fit affordable on every
    # render of a 13.3" panel on an ESP32.
    let lut = linearLut(profile)
    applyLut(image, lut, xStart, yStart, xEnd, yEnd)
    return
  for y in yStart ..< yEnd:
    breathe()
    for x in xStart ..< xEnd:
      let p = image.unsafe[x, y]
      let adjusted = adjustPixel(profile, p.r.float / 255.0, p.g.float / 255.0, p.b.float / 255.0)
      image.unsafe[x, y] = rgbx(
        uint8(max(0.0, min(255.0, (adjusted.r * 255.0).round()))),
        uint8(max(0.0, min(255.0, (adjusted.g * 255.0).round()))),
        uint8(max(0.0, min(255.0, (adjusted.b * 255.0).round()))),
        p.a,
      )

# ----------------------------------------------------------------- hooks

proc applyAutoFitToDrawn*(canvas: Image, x0, y0, width, height: int, source: Image = nil) =
  ## The consumer's half: called by whoever just drew an image onto the
  ## canvas, with the rectangle it landed on. Fits that rectangle into the
  ## panel's range when the frame asks for it and the source was not graded
  ## by its own sidecar. Nothing is allocated beyond a histogram.
  if canvas.isNil or not autoFitActive():
    return
  if not source.isNil and isImageGraded(source):
    return
  if source.isNil and isImageGraded(canvas):
    return
  probe(phFit):
    let endPoints = autoEndPoints(canvas, x0, y0, width, height, assetColorsPanelPalette)
    if endPoints.isSome:
      var profile = AssetColorProfile()
      profile.whites = endPoints.get().whites
      profile.blacks = endPoints.get().blacks
      applyAssetColors(canvas, profile, x0, y0, width, height)

proc applyGlobalColorCorrection*(canvas: Image) =
  ## The frame-wide correction, once per render on the finished canvas.
  if canvas.isNil or not frameColorSettings.global.hasAdjustments():
    return
  applyAssetColors(canvas, frameColorSettings.global)

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


const
  AssetColorSidecarSuffix* = ".frameos.json"
  ## Sidecars are tiny; a bigger file is not one of ours.
  AssetColorSidecarMaxBytes = 65536
  ## Hue range centres, degrees, in the order the sidecar lists them.
  HueRangeNames* = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"]
  HueRangeCentres = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0]
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
    ## a luminance shift (-100 .. 100) for the colours near one hue centre.
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

proc parseAssetColorProfile*(root: JsonNode): Option[AssetColorProfile] =
  ## `{"version": 1, "colors": {...}}`. Unknown keys are ignored, missing
  ## ones are neutral, so an older runtime reads a newer file.
  if root.isNil or root.kind != JObject:
    return none(AssetColorProfile)
  let colors = root{"colors"}
  if colors.isNil or colors.kind != JObject:
    return none(AssetColorProfile)
  var profile = AssetColorProfile(
    exposure: sliderOf(colors, "exposure", -3.0, 3.0),
    contrast: sliderOf(colors, "contrast"),
    whites: sliderOf(colors, "whites"),
    blacks: sliderOf(colors, "blacks"),
    saturation: sliderOf(colors, "saturation"),
    shadows: toneOf(colors, "shadows"),
    midtones: toneOf(colors, "midtones"),
    highlights: toneOf(colors, "highlights"),
    palette: parsePalette(colors{"palette"}),
  )
  let hues = colors{"hues"}
  for i, name in HueRangeNames:
    let hue = if hues.isNil or hues.kind != JObject: nil else: hues{name}
    profile.hues[i] = HueRange(
      hue: sliderOf(hue, "hue", -180.0, 180.0),
      saturation: sliderOf(hue, "saturation"),
      luminance: sliderOf(hue, "luminance"),
    )
  some(profile)

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

const
  ## How far the end points travel at ±100: a white point of 1.4 is what a
  ## Spectra panel's white (luminance 0.74) needs to take a photo's full
  ## range, which is what the editor's Auto preset asks for.
  EndPointRange* = 0.4

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

proc applyAssetColors*(image: Image, profile: AssetColorProfile,
    x0 = 0, y0 = 0, width = -1, height = -1) =
  ## Adjusts every pixel of `image` — or of one rectangle of it, for an image
  ## decoded straight into the render canvas that only owns the fitted part —
  ## in place. Alpha is kept; the colours are taken as straight (a photo has
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
  for y in yStart ..< yEnd:
    for x in xStart ..< xEnd:
      let p = image.unsafe[x, y]
      let adjusted = adjustPixel(profile, p.r.float / 255.0, p.g.float / 255.0, p.b.float / 255.0)
      image.unsafe[x, y] = rgbx(
        uint8(max(0.0, min(255.0, (adjusted.r * 255.0).round()))),
        uint8(max(0.0, min(255.0, (adjusted.g * 255.0).round()))),
        uint8(max(0.0, min(255.0, (adjusted.b * 255.0).round()))),
        p.a,
      )

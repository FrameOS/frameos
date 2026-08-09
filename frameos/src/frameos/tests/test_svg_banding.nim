import std/[strutils, math, options]
import pixie
import ../utils/image
import ../utils/memory

# Rasterising an SVG that paints with a gradient costs 3x its output image in
# pixie: the output plus the mask+fill pair `fillPath` allocates for non-solid
# paints. On memory-tight devices `decodeSvgWithFallback` renders the SVG one
# horizontal band at a time so only the band-sized pair is ever live. The
# banded result must match the one-pass result.

proc buildSvg(width, height: int): string =
  var parts: seq[string] = @[]
  parts.add("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" & $width &
    "\" height=\"" & $height & "\" viewBox=\"0 0 " & $width & " " & $height & "\">")
  # pixie ignores <defs>; gradients have to sit at the top level and be in
  # user space (the same shape the bundled JS apps emit).
  parts.add("<linearGradient id=\"bg\" gradientUnits=\"userSpaceOnUse\" " &
    "x1=\"0\" y1=\"0\" x2=\"0\" y2=\"" & $height & "\">" &
    "<stop offset=\"0\" stop-color=\"#12305a\"/><stop offset=\"1\" stop-color=\"#7a1f4b\"/>" &
    "</linearGradient>")
  parts.add("<rect x=\"0\" y=\"0\" width=\"" & $width & "\" height=\"" & $height &
    "\" fill=\"url(#bg)\"/>")
  # Solid shapes, strokes and transforms spread over the whole canvas so every
  # band contains geometry that starts outside it.
  for i in 0 ..< 24:
    let
      cx = 20.0 + i.float * (width.float - 40.0) / 24.0
      cy = 10.0 + (i mod 7).float * (height.float - 20.0) / 7.0
      r = 6.0 + (i mod 5).float * 4.0
    parts.add("<circle cx=\"" & formatFloat(cx, ffDecimal, 2) & "\" cy=\"" &
      formatFloat(cy, ffDecimal, 2) & "\" r=\"" & formatFloat(r, ffDecimal, 2) &
      "\" fill=\"#ffcc33\" fill-opacity=\"0.7\"/>")
    parts.add("<line x1=\"0\" y1=\"" & formatFloat(cy, ffDecimal, 2) & "\" x2=\"" &
      $width & "\" y2=\"" & formatFloat(cy + 13.5, ffDecimal, 2) &
      "\" stroke=\"#ffffff\" stroke-width=\"1.5\" stroke-opacity=\"0.5\"/>")
  parts.add("<g transform=\"translate(12 9)\">")
  var d = "M 0 " & $(height div 2)
  for i in 1 .. 40:
    let
      x = i.float * width.float / 40.0
      y = height.float / 2.0 + sin(i.float / 3.0) * height.float / 5.0
    d.add(" L " & formatFloat(x, ffDecimal, 2) & " " & formatFloat(y, ffDecimal, 2))
  parts.add("<path d=\"" & d & "\" fill=\"none\" stroke=\"#33ffaa\" stroke-width=\"2.5\"/>")
  parts.add("</g>")
  parts.add("</svg>")
  parts.join("")

proc maxChannelDiff(a, b: Image): (int, int) =
  ## (largest per-channel difference, number of differing pixels)
  doAssert a.width == b.width and a.height == b.height
  var worst = 0
  var differing = 0
  for i in 0 ..< a.data.len:
    let
      p = a.data[i]
      q = b.data[i]
      d = max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)),
              max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int)))
    if d > 0:
      inc differing
      if d > worst: worst = d
  (worst, differing)

const W = 400
const H = 320

let svg = buildSvg(W, H)
doAssert svgNeedsPaintServer(svg)
doAssert not svgNeedsPaintServer(svg.replace("url(#bg)", "#123456"))

# Hosts and RAM-rich frames keep pixie's single-pass behaviour.
availableRenderBytesOverride = 0
doAssert svgBandHeight(W, H, svg) == H, "unlimited memory must not band"
availableRenderBytesOverride = 512 * 1024 * 1024
doAssert svgBandHeight(W, H, svg) == H, "a roomy budget must not band"
doAssert svgBandHeight(W, H, svg.replace("url(#bg)", "#123456")) == H,
  "gradient-free SVGs must never band"

let reference = decodeSvgWithFallback(svg, W, H)
doAssert reference.isSome
doAssert reference.get().width == W and reference.get().height == H

# ESP32-class headroom: the 3x one-pass plan no longer fits.
availableRenderBytesOverride = 2 * 1024 * 1024
let bandHeight = svgBandHeight(W, H, svg)
doAssert svgBandHeight(W, H, svg.replace("url(#bg)", "#123456")) == H,
  "gradient-free SVGs must never band, however tight memory is"
doAssert bandHeight < H, "a tight budget must band, got " & $bandHeight
doAssert bandHeight >= 8

let banded = decodeSvgWithFallback(svg, W, H)
doAssert banded.isSome
doAssert banded.get().width == W and banded.get().height == H

let (worst, differing) = maxChannelDiff(reference.get(), banded.get())
# The band transform is an exact integer device-space translation, so the same
# scanlines get the same coverage. Only float32 rounding of the shifted shape
# coordinates can nudge an antialiased edge sample, so a handful of pixels may
# differ by a bit or two.
doAssert worst <= 8, "banded SVG differs by " & $worst & " (max channel)"
doAssert differing * 100 <= W * H,
  "banded SVG differs in " & $differing & " of " & $(W * H) & " pixels"

# An SVG whose root already carries a transform must come back unchanged too.
let rotated = svg.replace("<svg xmlns=", "<svg transform=\"translate(3 5)\" xmlns=")
availableRenderBytesOverride = 0
let rotatedReference = decodeSvgWithFallback(rotated, W, H)
doAssert rotatedReference.isSome
availableRenderBytesOverride = 2 * 1024 * 1024
let rotatedBanded = decodeSvgWithFallback(rotated, W, H)
doAssert rotatedBanded.isSome
let (rotWorst, rotDiffering) = maxChannelDiff(rotatedReference.get(), rotatedBanded.get())
doAssert rotWorst <= 8, "banded SVG with a root transform differs by " & $rotWorst
doAssert rotDiffering * 100 <= W * H

# Malformed SVG still fails the same way through the banded entry point.
availableRenderBytesOverride = 2 * 1024 * 1024
doAssert decodeSvgWithFallback("<svg>not really", W, H).isNone

availableRenderBytesOverride = 0

echo "test_svg_banding: bandHeight=", bandHeight, " worstDiff=", worst,
  " differingPixels=", differing, "/", W * H

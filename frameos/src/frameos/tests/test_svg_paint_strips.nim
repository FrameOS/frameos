import std/[strutils, math, options]
import pixie
import pixie/decodebudget
import ../utils/image
import ../utils/memory

# An SVG that paints with a gradient costs pixie a coverage mask and a paint
# image per gradient-filled path. Under the decode budget those are row
# strips (pixie `paintStripRows`), which is what lets a 1200x1600 e-ink
# canvas render the Weather scene's gradient sky on an ESP32. FrameOS feeds
# that budget from live memory right before rasterising, in both entry
# points, and the strips must land the one-pass picture.

proc buildSvg(width, height: int): string =
  var parts: seq[string] = @[]
  parts.add("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" & $width &
    "\" height=\"" & $height & "\" viewBox=\"0 0 " & $width & " " & $height & "\">")
  # Gradients in user space, the shape the bundled JS apps emit; the linear
  # one at the top level and the radial one in <defs>, both of which pixie
  # registers.
  parts.add("<linearGradient id=\"bg\" gradientUnits=\"userSpaceOnUse\" " &
    "x1=\"0\" y1=\"0\" x2=\"0\" y2=\"" & $height & "\">" &
    "<stop offset=\"0\" stop-color=\"#12305a\"/><stop offset=\"1\" stop-color=\"#7a1f4b\"/>" &
    "</linearGradient>")
  parts.add("<defs><radialGradient id=\"glow\" gradientUnits=\"userSpaceOnUse\" " &
    "cx=\"" & $(width div 3) & "\" cy=\"" & $(height div 3) & "\" r=\"" & $(width div 2) & "\" " &
    "gradientTransform=\"rotate(25 " & $(width div 3) & " " & $(height div 3) & ") scale(1 0.7)\">" &
    "<stop offset=\"0\" stop-color=\"#ffe08a\" stop-opacity=\"0.9\"/>" &
    "<stop offset=\"0.5\" stop-color=\"#ff7a45\" stop-opacity=\"0.5\"/>" &
    "<stop offset=\"1\" stop-color=\"#ff7a45\" stop-opacity=\"0\"/>" &
    "</radialGradient></defs>")
  parts.add("<rect x=\"0\" y=\"0\" width=\"" & $width & "\" height=\"" & $height &
    "\" fill=\"url(#bg)\"/>")
  # A radial glow over the sky, spanning every strip.
  parts.add("<rect x=\"0\" y=\"0\" width=\"" & $width & "\" height=\"" & $height &
    "\" fill=\"url(#glow)\"/>")
  # Solid shapes, strokes and transforms spread over the whole canvas so every
  # strip contains geometry that starts outside it.
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
  # A second gradient shape on fractional coordinates under a transform.
  parts.add("<g transform=\"translate(12.5 9.25)\">")
  var d = "M 0 " & $(height div 2)
  for i in 1 .. 40:
    let
      x = i.float * width.float / 40.0
      y = height.float / 2.0 + sin(i.float / 3.0) * height.float / 5.0
    d.add(" L " & formatFloat(x, ffDecimal, 2) & " " & formatFloat(y, ffDecimal, 2))
  parts.add("<path d=\"" & d & " L " & $width & " " & $height & " L 0 " & $height &
    " z\" fill=\"url(#bg)\" fill-opacity=\"0.6\" stroke=\"#33ffaa\" stroke-width=\"2.5\"/>")
  parts.add("</g>")
  parts.add("</svg>")
  parts.join("")

proc maxChannelDiff(a, b: Image): (int, int) =
  ## (largest per-channel difference, number of differing pixels)
  doAssert a.width == b.width and a.height == b.height
  var worst = 0
  var differing = 0
  for i in 0 ..< a.dataLen:
    let
      p = a.data[i]
      q = b.data[i]
      d = max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)),
              max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int)))
    if d > 0:
      inc differing
      if d > worst: worst = d
  (worst, differing)

proc checkClose(name: string, reference, strips: Image) =
  let (worst, differing) = maxChannelDiff(reference, strips)
  # The strip translation is an exact integer device-space move, so the same
  # scanlines get the same coverage. Only float32 rounding of the shifted
  # shape coordinates can nudge an antialiased edge sample by a unit or two.
  doAssert worst <= 8, name & ": striped SVG differs by " & $worst & " (max channel)"
  doAssert differing * 100 <= reference.dataLen,
    name & ": striped SVG differs in " & $differing & " of " & $reference.dataLen & " pixels"
  echo "test_svg_paint_strips ", name, ": worstDiff=", worst, " differingPixels=",
    differing, "/", reference.dataLen

const W = 400
const H = 320

let svg = buildSvg(W, H)

proc backdrop(): Image =
  result = newImage(W, H)
  result.fill(rgba(30, 120, 60, 255))

# Hosts and RAM-rich frames keep pixie's single-pass behaviour.
availableRenderBytesOverride = 0
let reference = decodeSvgWithFallback(svg, W, H)
doAssert reference.isSome
doAssert reference.get().width == W and reference.get().height == H
doAssert paintStripRows(W, H) == H, "unlimited memory must not strip"
let referenceInto = backdrop()
doAssert renderSvgIntoTarget(svg, referenceInto)
doAssert paintStripRows(W, H) == H, "unlimited memory must not strip (into target)"

availableRenderBytesOverride = 512 * 1024 * 1024
discard decodeSvgWithFallback(svg, W, H)
doAssert paintStripRows(W, H) == H, "a roomy budget must not strip"

# ESP32-class headroom: 2 MB, of which the render budget is half and the
# strip pair half of that — a 400x320 mask+fill pair (1 MB) no longer fits.
availableRenderBytesOverride = 2 * 1024 * 1024
let strips = decodeSvgWithFallback(svg, W, H)
doAssert strips.isSome
doAssert paintStripRows(W, H) < H,
  "a tight budget must strip, got " & $paintStripRows(W, H) & " rows"
doAssert paintStripRows(W, H) >= 4
checkClose("standalone", reference.get(), strips.get())

# Into an existing target (the JS app / render/image fusion path): the output
# already exists, so the whole headroom is the budget — 1 MB here, of which
# the pair may take half, so a 400x320 pair (1 MB) still comes in strips.
availableRenderBytesOverride = 1024 * 1024
let stripsInto = backdrop()
doAssert renderSvgIntoTarget(svg, stripsInto)
doAssert paintStripRows(W, H) < H, "the into-target path must strip as well"
checkClose("into target", referenceInto, stripsInto)

# An SVG whose root already carries a transform must come back the same too.
let shifted = svg.replace("<svg xmlns=", "<svg transform=\"translate(3 5)\" xmlns=")
availableRenderBytesOverride = 0
let shiftedReference = decodeSvgWithFallback(shifted, W, H)
doAssert shiftedReference.isSome
availableRenderBytesOverride = 2 * 1024 * 1024
let shiftedStrips = decodeSvgWithFallback(shifted, W, H)
doAssert shiftedStrips.isSome
checkClose("root transform", shiftedReference.get(), shiftedStrips.get())

# Malformed SVG still fails the same way under a tight budget.
doAssert decodeSvgWithFallback("<svg>not really", W, H).isNone
doAssert not renderSvgIntoTarget("<svg>not really", backdrop())

availableRenderBytesOverride = 0
refreshDecodeBudget()
doAssert paintStripRows(W, H) == H

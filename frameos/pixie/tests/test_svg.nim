import pixie, pixie/fileformats/svg, strformat, strutils, xrays, xmlparser, xmltree

const files = [
  "line01",
  "polyline01",
  "polygon01",
  "rect01",
  "rect02",
  "circle01",
  "ellipse01",
  "triangle01",
  "quad01",
  "Ghostscript_Tiger",
  "scale",
  "miterlimit",
  "dashes",
  "dragon2"
]

for file in files:
  let image = readImage(&"tests/fileformats/svg/{file}.svg")
  image.xray(&"tests/fileformats/svg/masters/{file}.png")

block:
  let
    svg = parseSvg(
      readFile("tests/fileformats/svg/accessibility-outline.svg"),
      512, 512
    )
    image = newImage(svg)
  image.xray(&"tests/fileformats/svg/masters/accessibility-outline.png")

block:
  # Test using XML node by itself, see: https://github.com/treeform/pixie/pull/533
  let
    xmlNode = parseXml(readFile("tests/fileformats/svg/accessibility-outline.svg"))
    svg = parseSvg(
      xmlNode,
      512, 512
    )

block:
  # renderInto: rasterize straight into a buffer the caller already owns.
  #
  # For a caller that has a correctly sized image to hand — a render canvas, a
  # cell of a larger image — this is the difference between one image and two,
  # which on a memory-tight device is the difference between rendering and not.
  let data = readFile("tests/fileformats/svg/Ghostscript_Tiger.svg")

  block:
    # On a fresh transparent target it must be bit-identical to newImage: that
    # is the same rasterization, and `newImage`'s overwrite-first start is only
    # an optimisation for the case where overwrite and normal agree.
    let
      expected = newImage(parseSvg(data, 200, 200))
      actual = newImage(200, 200)
    parseSvg(data, 200, 200).renderInto(actual)
    doAssert expected.pixelsEqual(actual)

  block:
    # On a target that already has content it must match rendering on
    # transparent and then compositing the result — which is what it replaces.
    # Materialized rounds twice (rasterize, then blend) where this rounds once,
    # so one step of 8-bit quantization is the allowed difference.
    let fused = newImage(200, 200)
    fused.fill(rgba(20, 120, 60, 255))
    parseSvg(data, 200, 200).renderInto(fused)

    let materialized = newImage(200, 200)
    materialized.fill(rgba(20, 120, 60, 255))
    materialized.draw(newImage(parseSvg(data, 200, 200)), blendMode = NormalBlend)

    var worst = 0
    var differing = 0
    for i in 0 ..< fused.dataLen:
      var pixelWorst = 0
      pixelWorst = max(pixelWorst, abs(fused.data[i].r.int - materialized.data[i].r.int))
      pixelWorst = max(pixelWorst, abs(fused.data[i].g.int - materialized.data[i].g.int))
      pixelWorst = max(pixelWorst, abs(fused.data[i].b.int - materialized.data[i].b.int))
      pixelWorst = max(pixelWorst, abs(fused.data[i].a.int - materialized.data[i].a.int))
      if pixelWorst > 0: differing += 1
      worst = max(worst, pixelWorst)
    # The Tiger overlaps hundreds of semi-transparent paths, so the rounding
    # compounds rather than staying at a single step: each composite onto an
    # opaque background quantizes to a slightly different value than the same
    # composite onto transparency does before the final blend. A few units out
    # of 255 is the cost of not allocating the second image.
    doAssert worst <= 4, &"renderInto differs from draw by {worst}"
    doAssert differing * 100 div fused.dataLen <= 25,
      &"renderInto differs on {differing * 100 div fused.dataLen}% of pixels"

block:
  # Radial gradients, and the gradient features documents actually use: kept
  # in <defs>, percentage lengths, gradientTransform, stop-opacity. The focal
  # point (fx, fy) is accepted and ignored.
  let data = """<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
<defs>
  <clipPath id="unused"><rect width="10" height="10"/></clipPath>
  <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="60" cy="60" r="50" fx="60" fy="60">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="0.6" stop-color="#ffcc33"/>
    <stop offset="1" stop-color="#7a1f4b"/>
  </radialGradient>
  <radialGradient id="soft" gradientUnits="userSpaceOnUse" cx="50%" cy="50%" r="30%"
    gradientTransform="translate(150 60) scale(1 0.5) translate(-100 -60)">
    <stop offset="0%" stop-color="#12305a" stop-opacity="1"/>
    <stop offset="100%" stop-color="#12305a" style="stop-opacity:0"/>
  </radialGradient>
</defs>
<rect width="200" height="120" fill="#101010"/>
<circle cx="60" cy="60" r="50" fill="url(#glow)"/>
<rect x="100" y="0" width="100" height="120" fill="url(#soft)"/>
</svg>"""
  let image = newImage(parseSvg(data))
  image.xray("tests/fileformats/svg/masters/radialGradient.png")

  proc near(a, b: ColorRGBX, tolerance = 3): bool =
    abs(a.r.int - b.r.int) <= tolerance and abs(a.g.int - b.g.int) <= tolerance and
    abs(a.b.int - b.b.int) <= tolerance and abs(a.a.int - b.a.int) <= tolerance

  # glow: first stop at the centre, the 0.6 stop 30px out, background past r.
  doAssert image[60, 60] == rgbx(255, 255, 255, 255)
  doAssert image[90, 60].near(rgbx(255, 204, 51, 255)), $image[90, 60]
  doAssert image[60, 90].near(rgbx(255, 204, 51, 255)), $image[60, 90]
  doAssert image[60, 5] == rgbx(16, 16, 16, 255)
  # soft: cx/cy = 50% of the viewport = (100, 60), r = 30% of the normalised
  # diagonal ~ 49.5, moved to (150, 60) and squashed to half height. Opaque
  # at the centre, gone at the rim, half-and-half at t = 0.5 on either axis.
  doAssert image[150, 60] == rgbx(18, 48, 90, 255)
  doAssert image[199, 60].near(rgbx(16, 16, 16, 255), 2), $image[199, 60]
  doAssert image[150, 5] == rgbx(16, 16, 16, 255)
  doAssert image[175, 60].near(rgbx(17, 32, 53, 255)), $image[175, 60]
  doAssert image[150, 72].near(rgbx(17, 32, 53, 255)), $image[150, 72]

block:
  # gradientTransform on a linear gradient, and the SVG defaults for a
  # gradient vector (left to right across the viewport).
  let data = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
<linearGradient id="lr" gradientUnits="userSpaceOnUse">
  <stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/>
</linearGradient>
<linearGradient id="tb" gradientUnits="userSpaceOnUse" gradientTransform="rotate(90 50 25)">
  <stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/>
</linearGradient>
<rect width="100" height="25" fill="url(#lr)"/>
<rect y="25" width="100" height="25" fill="url(#tb)"/>
</svg>"""
  let image = newImage(parseSvg(data))
  doAssert image[0, 10] == rgbx(0, 0, 0, 255)
  doAssert image[99, 10].r > 250
  doAssert image[0, 10].r < image[50, 10].r and image[50, 10].r < image[99, 10].r
  # rotate(90 50 25) turns the (0,0)->(100,0) vector into (75,-25)->(75,75):
  # the lower rect brightens downwards and is constant across x.
  doAssert image[10, 49].r == image[90, 49].r, "rotated: constant across x"
  doAssert image[10, 49].r > image[10, 26].r, "rotated: brighter downwards"
  doAssert image[10, 26].r > 100 and image[10, 49].r < 200

block:
  # Gradient units other than user space are still refused, whole document.
  let data = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
<radialGradient id="g"><stop offset="0" stop-color="#000"/></radialGradient>
<rect width="10" height="10" fill="url(#g)"/></svg>"""
  doAssertRaises PixieError:
    discard parseSvg(data)

block:
  # No viewBox: the root's width/height are the user coordinate box, and a
  # requested size scales onto it exactly as a viewBox would. This used to
  # raise `invalid integer` for any size but the declared one.
  let data = """<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#ff0000"/><rect x="20" width="20" height="20" fill="#0000ff"/></svg>"""
  let natural = newImage(parseSvg(data))
  doAssert natural.width == 40 and natural.height == 20
  doAssert natural[5, 10] == rgbx(255, 0, 0, 255)
  doAssert natural[35, 10] == rgbx(0, 0, 255, 255)
  let scaled = newImage(parseSvg(data, 8, 4))
  doAssert scaled.width == 8 and scaled.height == 4
  doAssert scaled[1, 2] == rgbx(255, 0, 0, 255), $scaled[1, 2]
  doAssert scaled[6, 2] == rgbx(0, 0, 255, 255), $scaled[6, 2]

block:
  # viewBox with commas and decimals; unit suffixes on width/height dropped.
  let data = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0,0,40.0,20" width="40px" height="20px"><rect width="40" height="20" fill="#00ff00"/></svg>"""
  let image = newImage(parseSvg(data))
  doAssert image.width == 40 and image.height == 20
  doAssert image[20, 10] == rgbx(0, 255, 0, 255)

block:
  # Neither a viewBox nor a size on the document: the requested size is the
  # box (drawn unscaled), and no size at all is refused by name.
  let data = """<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#ff0000"/></svg>"""
  let image = newImage(parseSvg(data, 20, 20))
  doAssert image[5, 5] == rgbx(255, 0, 0, 255)
  doAssert image[15, 15] == rgbx(0, 0, 0, 0)
  var refused = ""
  try:
    discard parseSvg(data)
  except PixieError as e:
    refused = e.msg
  doAssert refused.contains("no viewBox"), refused

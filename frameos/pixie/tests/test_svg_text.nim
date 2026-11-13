import pixie, pixie/fileformats/svg, strformat, strtabs, xmltree

## <text> support: glyph outlines become ordinary SVG paths, so fill, stroke,
## gradients, opacity and transforms all apply to them unchanged.
##
## Lives apart from test_svg.nim because the typeface resolver is global state:
## the rest of the SVG tests must keep running with no resolver installed.

let
  regular = readTypeface("tests/fonts/Inter-Regular.ttf")
  bold = readTypeface("tests/fonts/Inter-Bold.ttf")
var asked: seq[string]

setSvgTypefaceResolver(
  proc(family: string, weight: int, italic: bool): Typeface {.gcsafe, raises: [].} =
    {.cast(gcsafe).}:
      asked.add family
      if family.len > 0 and family != "Inter" and family != "Comic Sans MS":
        return nil # Unknown family: decline, and let the next candidate answer
      if weight >= 600:
        return bold
      return regular
)

proc inkBounds(image: Image): Rect =
  ## The bounding box of everything drawn onto a transparent image.
  var
    minX = image.width
    minY = image.height
    maxX = -1
    maxY = -1
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      if image[x, y].a > 0:
        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x)
        maxY = max(maxY, y)
  if maxX < 0:
    return rect(0, 0, 0, 0)
  rect(minX.float32, minY.float32, (maxX - minX + 1).float32,
    (maxY - minY + 1).float32)

proc render(body: string, width = 200, height = 100): Image =
  newImage(parseSvg(
    &"""<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}">{body}</svg>""",
    width, height
  ))

block: # The baseline sits on y, and x starts the text
  let
    image = render("""<text x="20" y="60" font-size="40" font-family="Inter">Hg</text>""")
    ink = image.inkBounds()
  doAssert ink.w > 0 and ink.h > 0, "nothing was drawn"
  doAssert ink.x >= 19 and ink.x <= 24, &"text does not start at x=20: {ink}"
  # The cap height sits above the baseline, the descender of 'g' below it.
  doAssert ink.y > 25 and ink.y < 40, &"cap height is off: {ink}"
  doAssert ink.y + ink.h > 60, &"the descender should cross the baseline: {ink}"

block: # text-anchor moves the whole chunk, not each run
  let
    start = render("""<text x="100" y="60" font-size="20" text-anchor="start">anchor</text>""").inkBounds()
    middle = render("""<text x="100" y="60" font-size="20" text-anchor="middle">anchor</text>""").inkBounds()
    finish = render("""<text x="100" y="60" font-size="20" text-anchor="end">anchor</text>""").inkBounds()
  doAssert abs(start.w - middle.w) <= 1 and abs(start.w - finish.w) <= 1
  doAssert abs((middle.x + middle.w / 2) - 100) <= 2,
    &"middle anchor is not centered on x: {middle}"
  doAssert abs((finish.x + finish.w) - 100) <= 2,
    &"end anchor does not end at x: {finish}"

block: # dominant-baseline shifts the baseline, not the x position
  let
    alphabetic = render("""<text x="10" y="50" font-size="20">Ay</text>""").inkBounds()
    hanging = render("""<text x="10" y="50" font-size="20" dominant-baseline="hanging">Ay</text>""").inkBounds()
    middle = render("""<text x="10" y="50" font-size="20" dominant-baseline="middle">Ay</text>""").inkBounds()
  doAssert hanging.y > middle.y and middle.y > alphabetic.y,
    &"baselines are not ordered: {alphabetic} {middle} {hanging}"
  doAssert alphabetic.x == hanging.x and alphabetic.x == middle.x

block: # tspans continue the line, keep the space at the seam and take fills
  let image = render("""<text x="10" y="60" font-size="20" fill="#0000ff">one <tspan fill="#ff0000" font-weight="bold">two</tspan> three</text>""")
  var blue, red: int
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let c = image[x, y]
      if c.a > 200 and c.b > 200: inc blue
      if c.a > 200 and c.r > 200: inc red
  doAssert blue > 0 and red > 0, "tspan fill did not apply"

  # The space before "three" is content: without it the runs would collide.
  let joined = render("""<text x="10" y="60" font-size="20">one <tspan>two</tspan>three</text>""")
  doAssert image.inkBounds().w > joined.inkBounds().w,
    "the whitespace between a tspan and the text after it was lost"

block: # A positioned tspan starts a new chunk with its own anchoring
  let image = render("""<text x="10" y="30" font-size="16">first<tspan x="10" y="70">second</tspan></text>""")
  let ink = image.inkBounds()
  doAssert ink.h > 40, &"the tspan did not move to its own y: {ink}"

block: # A font-family list falls through to the first family we know
  asked.setLen(0)
  let image = render("""<text x="10" y="60" font-size="20" font-family="Nonesuch, 'Comic Sans MS', sans-serif">x</text>""")
  doAssert asked == @["Nonesuch", "Comic Sans MS"], &"candidates asked: {asked}"
  doAssert image.inkBounds().w > 0

block: # An entirely unknown family degrades to the default face, never fails
  asked.setLen(0)
  let image = render("""<text x="10" y="60" font-size="20" font-family="Nonesuch">x</text>""")
  doAssert asked == @["Nonesuch", ""], &"candidates asked: {asked}"
  doAssert image.inkBounds().w > 0

block: # font-size units, and a broken one inherits instead of failing
  let
    px = render("""<text x="10" y="60" font-size="20px">size</text>""").inkBounds()
    unitless = render("""<text x="10" y="60" font-size="20">size</text>""").inkBounds()
    pt = render("""<text x="10" y="60" font-size="15pt">size</text>""").inkBounds()
    inherited = render("""<g font-size="20"><text x="10" y="60" font-size="nonsense">size</text></g>""").inkBounds()
  doAssert px == unitless
  doAssert pt == unitless, &"15pt should be 20px: {pt} vs {unitless}"
  doAssert inherited == unitless

block: # Transforms, gradients and opacity treat text like any other path
  let image = render("""
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="0">
      <stop offset="0" stop-color="#ff0000"/>
      <stop offset="1" stop-color="#0000ff"/>
    </linearGradient>
    <g transform="translate(20 0)" opacity="0.5">
      <text x="0" y="60" font-size="30" fill="url(#g)">grad</text>
    </g>""")
  let ink = image.inkBounds()
  doAssert ink.w > 0
  doAssert ink.x >= 19, &"the group transform did not move the text: {ink}"
  var semi = 0
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      if image[x, y].a > 0 and image[x, y].a < 250: inc semi
  doAssert semi > 0, "group opacity did not apply to the text"

block: # Entities and multi-line source collapse the way SVG says they do
  let image = render("""<text x="10" y="60" font-size="20">a
    &amp; b&nbsp;c</text>""")
  doAssert image.inkBounds().w > 0

block: # Unsupported children are dropped, not fatal
  let image = render("""<text x="10" y="60" font-size="20"><title>tip</title>kept</text>""")
  doAssert image.inkBounds().w > 0

block: # Text renders the same when the document is rasterized in bands
  let body = """<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="10" y="60" font-size="24">banded</text>"""
  let
    whole = render(body)
    root = parseSvgXml(&"""<svg width="200" height="100" viewBox="0 0 200 100">{body}</svg>""")
  var banded = newImage(200, 100)
  for y in countup(0, 99, 25):
    root.attrs["transform"] = &"translate(0 {-y})"
    let svg = parseSvg(root, 200, 100)
    svg.height = 25
    let band = newImage(svg)
    copyMem(banded.data[y * 200].addr, band.data[0].addr, 25 * 200 * 4)
  var worst = 0
  for i in 0 ..< whole.dataLen:
    let a = whole.data[i]
    let b = banded.data[i]
    worst = max(worst, abs(a.r.int - b.r.int))
    worst = max(worst, abs(a.g.int - b.g.int))
    worst = max(worst, abs(a.b.int - b.b.int))
    worst = max(worst, abs(a.a.int - b.a.int))
  # A band boundary rounds antialiased coverage one step differently, the same
  # as it does for any other path; the glyphs themselves land in the same place.
  doAssert worst <= 1, &"banded text differs from a whole render by {worst}"

block: # Without a resolver, text is skipped and the rest of the drawing lives
  setSvgTypefaceResolver(nil)
  let image = render("""<rect x="0" y="0" width="10" height="10" fill="#ff0000"/><text x="10" y="60" font-size="20">gone</text>""")
  doAssert image[5, 5] == rgbx(255, 0, 0, 255)
  doAssert image.inkBounds() == rect(0, 0, 10, 10), "text drew without a font"

echo "test_svg_text ok"

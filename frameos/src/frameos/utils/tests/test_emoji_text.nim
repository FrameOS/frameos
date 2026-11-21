import std/[options, os, strutils, unittest, unicode]
import pixie
import pixie/paths
import pixie/fileformats/svg
import ../svg_frames
import ../font # the typeface resolver SVG and JSX text use
import ../../ui/layout

# Emoji in JSX and SVG text (docs/jsx-ui.md "Text and fonts",
# docs/esp32-fonts.md "Emoji"): a colour glyph is a picture, so where the
# text's glyphs are paths each emoji is an <image> at the pen, drawn by the
# same pass as the rest (damage repaints included), from the emoji face the
# frame's fonts folder has, read in place on every host. They draw as the
# Text app's do, take their advance in the layout, and a canvas of fewer
# colours dithers them like any picture.

let assets = normalizedPath(currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "assets" / "copied")
setSvgFontAssetsPath(assets)
colorGlyphCacheBudget = 256 * 1024
glyphCacheBudget = 256 * 1024

proc colored(image: Image, box = rect(0, 0, 0, 0)): int =
  ## Pixels clearly not grey (an emoji's), in `box` (the whole image for none).
  let
    x0 = if box.w > 0: box.x.int else: 0
    y0 = if box.w > 0: box.y.int else: 0
    x1 = if box.w > 0: int(box.x + box.w) else: image.width
    y1 = if box.w > 0: int(box.y + box.h) else: image.height
  for y in y0 ..< y1:
    for x in x0 ..< x1:
      let p = image[x, y]
      if max(max(p.r, p.g), p.b).int - min(min(p.r, p.g), p.b).int > 60:
        inc result

proc meanDiff(a, b: Image): float =
  var total = 0.0
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let (p, q) = (a[x, y], b[x, y])
      total += max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)), abs(p.b.int - q.b.int)).float
  total / (a.width * a.height).float

proc el(tag, classes: string, children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  if classes.len > 0:
    result.attrs.add(("class", classes))
  for child in children:
    result.children.add child

proc txt(text: string): SvgNode = SvgNode(text: text)

proc drawUi(canvas: Image, root: SvgNode): SvgNode =
  var input: UiInput
  var regions: seq[UiRegion]
  result = layoutUi(root, canvas.width, canvas.height, input, regions)
  parseSvg(result, canvas.width, canvas.height).renderInto(canvas)

proc images(svg: SvgNode): seq[SvgNode] =
  for node in svg.children:
    if node.tag == "image" and not node.image.isNil:
      result.add node
    result.add node.images()

const line = "Hi 😀 the 🎉 party"

suite "emoji in SVG and JSX text":
  test "SVG <text> draws emoji as the Text app does":
    let svg = parseSvg("""<svg xmlns="http://www.w3.org/2000/svg" width="420" height="60">""" &
      """<rect width="420" height="60" fill="#fff"/>""" &
      """<text x="10" y="40" font-size="32" fill="#000">""" & line & """</text></svg>""", 420, 60)
    let a = newImage(420, 60)
    svg.renderInto(a)
    # The Text app: fillText with the default face and its emoji fallback.
    let b = newImage(420, 60)
    b.fill(rgba(255, 255, 255, 255))
    let font = newFont(getTypeface("", assets))
    font.size = 32
    font.paint = parseHtmlColor("#000")
    b.fillText(font.typeset(line, wrap = false), translate(vec2(10, 40 - font.baselineOffset)))
    check a.colored() > 300
    check b.colored() > 300
    check abs(a.colored() - b.colored()) < a.colored() div 10
    check meanDiff(a, b) < 4
    let shots = getEnv("FRAMEOS_EMOJI_SHOTS")
    if shots.len > 0:
      createDir(shots)
      a.writeFile(shots / "svg-emoji.png")
      b.writeFile(shots / "textapp-emoji.png")

  test "JSX text: an <image> where each emoji goes, with its advance in the layout":
    let canvas = newImage(420, 80)
    let with = canvas.drawUi(el("div", "w-full h-full bg-white p-2 flex flex-col",
      el("span", "text-3xl text-black", txt(line))))
    let pictures = with.images()
    check pictures.len == 2
    check canvas.colored() > 300
    # The layout measured the emoji: the word after one sits past it.
    let plain = newImage(420, 80)
    discard plain.drawUi(el("div", "w-full h-full bg-white p-2 flex flex-col",
      el("span", "text-3xl text-black", txt("Hi the party"))))
    var rightmostWith, rightmostPlain = 0
    for y in 0 ..< 80:
      for x in 0 ..< 420:
        if canvas[x, y].r < 128: rightmostWith = max(rightmostWith, x)
        if plain[x, y].r < 128: rightmostPlain = max(rightmostPlain, x)
    check rightmostWith > rightmostPlain + 40
    let shots = getEnv("FRAMEOS_EMOJI_SHOTS")
    if shots.len > 0:
      canvas.writeFile(shots / "jsx-emoji.png")

  test "a canvas of fewer colours dithers them like a picture":
    for kind in ["565", "gray4", "gray8"]:
      checkpoint kind
      let canvas =
        case kind
        of "565": newImage565(420, 60)
        of "gray4": newImageGray4(420, 60)
        else: newImageGray8(420, 60)
      let svg = parseSvg("""<svg xmlns="http://www.w3.org/2000/svg" width="420" height="60">""" &
        """<rect width="420" height="60" fill="#fff"/>""" &
        """<text x="10" y="40" font-size="32" fill="#000">""" & line & """</text></svg>""", 420, 60)
      svg.renderInto(canvas)
      # Something drawn where the first emoji is, neither paper nor ink only.
      var shades = 0
      for y in 10 ..< 50:
        for x in 50 ..< 90:
          let v = canvas[x, y].r.int
          if v > 30 and v < 225: inc shades
      if kind == "565": check canvas.colored() > 200
      check shades > 50

  test "a damage repaint over emoji comes out as a whole render":
    const W = 300
    const H = 120
    proc doc(i: int): string =
      """<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120">""" &
        """<rect width="300" height="120" fill="#f8fafc"/>""" &
        """<text x="10" y="50" font-size="28" fill="#111">Count """ & $i & """ 😀🎉</text>""" &
        """<rect x="""" & $(150 + (i mod 4) * 30) & """" y="80" width="20" height="20" fill="#0ea5e9"/></svg>"""
    var storage: array[2, seq[uint16]]
    var buffers: array[2, Image]
    for b in 0 .. 1:
      storage[b] = newSeq[uint16](W * H)
      buffers[b] = newImage565Over(W, H, addr storage[b][0])
      buffers[b].ditherStores = true
    for i in 0 ..< 8:
      let target = buffers[i mod 2]
      beginPanelFrame(target.bufferPointer, 0)
      var owed = some(color(0, 0, 0, 1))
      check renderSvgFrame(doc(i), target, owed, true)
      endPanelFrame()
      let whole = newImage565(W, H)
      whole.ditherStores = true
      parseSvg(doc(i), W, H).renderInto(whole)
      var worst = 0
      for y in 0 ..< H:
        for x in 0 ..< W:
          let (p, q) = (target[x, y], whole[x, y])
          worst = max(worst, max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)), abs(p.b.int - q.b.int)))
      checkpoint "frame " & $i
      check worst <= 9
      check target.colored(rect(100, 20, 80, 40)) > 50

  test "kept at their drawn size, within the colour glyph budget":
    clearColorGlyphCache()
    colorGlyphDecodes = 0
    let canvas = newImage(420, 80)
    for i in 0 .. 2:
      newGlyphCachePass()
      discard canvas.drawUi(el("div", "w-full h-full bg-white p-2",
        el("span", "text-3xl text-black", txt(line))))
    check colorGlyphDecodes == 2 # once each, then from the cache
    check colorGlyphCacheBytes() <= colorGlyphCacheBudget

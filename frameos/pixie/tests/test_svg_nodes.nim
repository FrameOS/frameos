import pixie, pixie/fileformats/svg

# A drawing handed to parseSvg as nodes, without markup: the same drawing as
# its markup, plus the two things only nodes can carry, a decoded picture for
# `<image>` and a ready outline for `<path>`.

proc el(tag: string, attrs: openArray[(string, string)], children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  for attr in attrs:
    result.attrs.add attr
  for child in children:
    result.children.add child

proc same(a, b: Image): bool =
  if a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

block: # Nodes draw what their markup draws
  let
    markup = """<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30"><rect width="40" height="30" fill="#102030"/><g transform="translate(5 4) scale(2)" opacity="0.5"><circle cx="5" cy="5" r="4" fill="#ff0000" stroke="#fff" stroke-width="1"/></g><path d="M0 0L10 20H30Z" fill="#00ff00" fill-rule="evenodd"/></svg>"""
    nodes = el("svg", {"width": "40", "height": "30", "viewBox": "0 0 40 30"},
      el("rect", {"width": "40", "height": "30", "fill": "#102030"}),
      el("g", {"transform": "translate(5 4) scale(2)", "opacity": "0.5"},
        el("circle", {"cx": "5", "cy": "5", "r": "4", "fill": "#ff0000",
          "stroke": "#fff", "stroke-width": "1"})),
      el("path", {"d": "M0 0L10 20H30Z", "fill": "#00ff00", "fill-rule": "evenodd"}))
  doAssert same(newImage(parseSvg(markup, 80, 60)), newImage(parseSvg(nodes, 80, 60)))
  doAssert parseSvg(nodes, 40, 30).coversOpaque(40, 30)

block: # A <path> can carry its outline instead of `d`
  let outline = newPath()
  outline.rect(2, 2, 6, 4)
  let
    node = el("path", {"fill": "#ff0000"})
    root = el("svg", {"width": "10", "height": "10"}, node)
  node.path = outline
  let image = newImage(parseSvg(root, 10, 10))
  doAssert image[4, 3] == rgbx(255, 0, 0, 255)
  doAssert image[1, 1] == rgbx(0, 0, 0, 0)

proc picture(): Image =
  ## 4x2: red on the left half, blue on the right.
  result = newImage(4, 2)
  for y in 0 ..< 2:
    for x in 0 ..< 4:
      result[x, y] = if x < 2: rgbx(255, 0, 0, 255) else: rgbx(0, 0, 255, 255)

proc drawImage(aspect: string, opacity = ""): Image =
  let node = el("image", {"x": "2", "y": "2", "width": "8", "height": "8",
    "preserveAspectRatio": aspect, "opacity": opacity})
  node.image = picture()
  result = newImage(parseSvg(el("svg", {"width": "12", "height": "12"}, node), 12, 12))

block: # <image> fits its picture the way preserveAspectRatio says
  let meet = drawImage("xMidYMid meet") # 8x4, centred: rows 4..7
  doAssert meet[3, 5] == rgbx(255, 0, 0, 255)
  doAssert meet[8, 5] == rgbx(0, 0, 255, 255)
  doAssert meet[5, 2].a == 0 and meet[5, 9].a == 0

  let slice = drawImage("xMidYMid slice") # 16x8 centred on the box, clipped to it
  # Four times larger, smooth: red up to column 3, blue from 8, the four
  # columns around the split (source column 2, at x = 6) a mix of the two.
  doAssert slice[3, 5] == rgbx(255, 0, 0, 255)
  doAssert slice[8, 5] == rgbx(0, 0, 255, 255)
  doAssert slice[5, 5].r > slice[5, 5].b and slice[5, 5].b > 0
  doAssert slice[6, 5].b > slice[6, 5].r and slice[6, 5].r > 0
  doAssert slice[2, 2].a == 255 and slice[9, 9].a == 255
  doAssert slice[1, 5].a == 0 and slice[10, 5].a == 0 # nothing outside the box

  let stretched = drawImage("none") # 8x8
  doAssert stretched[3, 8] == rgbx(255, 0, 0, 255)
  doAssert stretched[8, 3] == rgbx(0, 0, 255, 255)

  let faded = drawImage("none", "0.5")
  doAssert faded[3, 5].a in 126'u8 .. 129'u8

block: # The same picture in the same box is no damage; moved, both boxes are
  let pic = picture()
  proc frame(x: int): Svg =
    let node = el("image", {"x": $x, "y": "0", "width": "4", "height": "2"})
    node.image = pic
    parseSvg(el("svg", {"width": "20", "height": "10"},
      el("rect", {"width": "20", "height": "10", "fill": "#000"}), node), 20, 10)
  doAssert damage(frame(2), frame(2), 20, 10).w == 0
  let moved = damage(frame(2), frame(10), 20, 10)
  doAssert not moved.full and moved.x <= 2 and moved.x + moved.w >= 14

block: # Markup has no way to name a picture: <image> there stays unsupported
  var raised = false
  try:
    discard parseSvg("""<svg width="4" height="4"><image href="x.png" width="4" height="4"/></svg>""")
  except PixieError:
    raised = true
  doAssert raised

block: # An RGB565 target takes an <image> too
  let node = el("image", {"width": "4", "height": "2", "preserveAspectRatio": "none"})
  node.image = picture()
  let target = newImage565(4, 2)
  parseSvg(el("svg", {"width": "4", "height": "2"}, node), 4, 2).renderInto(target)
  doAssert target[0, 0].r > 200 and target[3, 1].b > 200

block: # A 565 picture scaled onto a 565 target: its nearest pixels, wherever it lands
  const
    red = rgbx(255, 0, 0, 255)
    blue = rgbx(0, 0, 255, 255)
    green = rgbx(0, 255, 0, 255)
    white = rgbx(255, 255, 255, 255)
    black = rgbx(0, 0, 0, 255)
  # 4x4: red top left, blue top right, green bottom left, white bottom right.
  let pic = newImage565(4, 4)
  for y in 0 ..< 4:
    for x in 0 ..< 4:
      pic[x, y] = if y < 2: (if x < 2: red else: blue) else: (if x < 2: green else: white)
  proc drawn(w, h: int, x, y, bw, bh: string, rendering = "pixelated"): Image =
    let node = el("image", {"x": x, "y": y, "width": bw, "height": bh, "preserveAspectRatio": "none",
      "image-rendering": rendering})
    node.image = pic
    result = newImage565(w, h)
    result.fill(black)
    parseSvg(el("svg", {"width": $w, "height": $h}, node), w, h).renderInto(result)

  block: # twice the size, edges sharp
    let t = drawn(8, 8, "0", "0", "8", "8")
    doAssert t[3, 3] == red and t[4, 3] == blue and t[3, 4] == green and t[4, 4] == white
    doAssert t[0, 0] == red and t[7, 7] == white

  block: # only when asked: any other picture stays smooth
    let t = drawn(6, 6, "0", "0", "6", "6", rendering = "auto") # 1.5x: exactly 2x is blocky anyway
    doAssert t[2, 1] != red and t[2, 1] != blue
    let blocky = drawn(6, 6, "0", "0", "6", "6")
    doAssert blocky[2, 1] == red or blocky[2, 1] == blue

  block: # half the size picks pixels, it does not mix them
    let t = drawn(2, 2, "0", "0", "2", "2")
    doAssert t[0, 0] == red and t[1, 0] == blue and t[0, 1] == green and t[1, 1] == white

  block: # hanging off every side: no fault, and only what is inside drawn
    let t = drawn(6, 6, "-4", "-4", "16", "16") # 4x: each quadrant 8 px, split at 4
    doAssert t[3, 3] == red and t[4, 3] == blue and t[3, 4] == green and t[5, 5] == white
    let small = drawn(6, 6, "4", "4", "8", "8")
    doAssert small[3, 3] == black and small[4, 4] == red and small[5, 5] == red

  block: # around the box nothing changes, at a fractional place and scale
    let t = drawn(12, 12, "1.5", "2.5", "6", "6")
    doAssert t[0, 5] == black and t[8, 5] == black and t[5, 1] == black and t[5, 9] == black
    doAssert t[2, 3] == red and t[6, 7] == white

  block: # a window of the target repaints what a whole render would
    let
      node = el("image", {"x": "1", "y": "1", "width": "10", "height": "10", "preserveAspectRatio": "none",
        "image-rendering": "pixelated"})
      whole = newImage565(12, 12)
      windowed = newImage565(12, 12)
    node.image = pic
    let svg = parseSvg(el("svg", {"width": "12", "height": "12"}, node), 12, 12)
    whole.fill(black)
    windowed.fill(black)
    svg.renderInto(whole)
    svg.renderInto(windowed.view(3, 4, 5, 6), 3, 4)
    for y in 4 ..< 10:
      for x in 3 ..< 8:
        doAssert windowed[x, y] == whole[x, y], $x & "," & $y

echo "test_svg_nodes ok"

block:
  # reuse: the same child node handed over again comes back as the same
  # elements, known to damageRects without a compare; a changed one is
  # parsed again, and a parse under other properties does not take them.
  let
    keep = SvgNode(tag: "rect", attrs: @[("x", "2"), ("y", "2"), ("width", "8"), ("height", "8"), ("fill", "#f00")])
    moving = proc(x: int): SvgNode = SvgNode(tag: "rect", attrs: @[("x", $x), ("y", "20"), ("width", "6"), ("height", "6"), ("fill", "#00f")])
    a = SvgNode(tag: "svg", attrs: @[("width", "40"), ("height", "40")], children: @[keep, moving(2)])
    b = SvgNode(tag: "svg", attrs: @[("width", "40"), ("height", "40")], children: @[keep, moving(20)])
    first = parseSvg(a, 40, 40, reuse = true)
    second = parseSvg(b, 40, 40, reuse = true)
    found = damageRects(first, second, 40, 40)
  doAssert not found.full and found.rects.len > 0
  for r in found.rects:
    doAssert r.y >= 17, $found.rects # where the moved rect was and is, not the kept one
  # Drawn the same as a parse without reuse.
  let
    reused = newImage(40, 40)
    plain = newImage(40, 40)
  second.renderInto(reused)
  parseSvg(b, 40, 40).renderInto(plain)
  for y in 0 ..< 40:
    for x in 0 ..< 40:
      doAssert reused[x, y] == plain[x, y]
  # Under another size (other inherited properties) the kept node is parsed again.
  let other = parseSvg(b, 80, 80, reuse = true)
  doAssert not damageRects(second, other, 80, 80).full
  echo "svg node reuse ok"

block:
  # pictures: the <image> elements an SVG draws, where, for a caller that
  # changes a picture's pixels in place; hidden ones are not listed.
  let picture = newImage(10, 5)
  let doc = SvgNode(tag: "svg", attrs: @[("width", "40"), ("height", "40")], children: @[
    SvgNode(tag: "rect", attrs: @[("width", "40"), ("height", "40"), ("fill", "#fff")]),
    SvgNode(tag: "image", attrs: @[("x", "4"), ("y", "6"), ("width", "20"), ("height", "10")], image: picture),
    SvgNode(tag: "image", attrs: @[("x", "0"), ("y", "0"), ("width", "8"), ("height", "8"),
      ("opacity", "0")], image: picture)])
  var found: seq[SvgPicture]
  for p in parseSvg(doc, 80, 80).pictures:
    found.add p
  doAssert found.len == 1
  doAssert found[0].image == picture and found[0].box == rect(4, 6, 20, 10) and found[0].clip.w < 0
  doAssert found[0].transform * vec2(4, 6) == vec2(8, 12) # parsed at twice the size
  echo "svg pictures ok"

block: # A nested <svg> is a viewport: drawn from its corner, clipped to it
  let
    inner = el("svg", {"x": "4", "y": "2", "width": "6", "height": "5", "viewBox": "10 20 6 5"},
      # A 20x20 square from (10, 20): only the viewport's 6x5 of it shows.
      el("rect", {"x": "10", "y": "20", "width": "20", "height": "20", "fill": "#ff0000"}))
    image = newImage(parseSvg(el("svg", {"width": "16", "height": "12"}, inner), 16, 12))
  for y in 0 ..< 12:
    for x in 0 ..< 16:
      let inside = x >= 4 and x < 10 and y >= 2 and y < 7
      doAssert (image[x, y] == rgbx(255, 0, 0, 255)) == inside, $x & "," & $y

block: # Scrolled: the viewBox moves the content, the clip stays
  let
    content = el("rect", {"x": "0", "y": "0", "width": "8", "height": "4", "fill": "#00ff00"})
    scrolled = el("svg", {"x": "0", "y": "4", "width": "8", "height": "4", "viewBox": "0 2 8 4"}, content)
    image = newImage(parseSvg(el("svg", {"width": "8", "height": "12"}, scrolled), 8, 12))
  # The rect's lower half (y 2..3) at the viewport's top (y 4..5), nothing else.
  for y in 0 ..< 12:
    doAssert (image[3, y] == rgbx(0, 255, 0, 255)) == (y >= 4 and y < 6), $y

block: # Nested viewports clip to both; bounds and damage stay inside the clip
  let
    deep = el("svg", {"x": "0", "y": "0", "width": "20", "height": "20"},
      el("rect", {"x": "0", "y": "0", "width": "20", "height": "20", "fill": "#0000ff"}))
    outer = el("svg", {"x": "2", "y": "3", "width": "5", "height": "4"}, deep)
    svg = parseSvg(el("svg", {"width": "20", "height": "20"}, outer), 20, 20)
    image = newImage(svg)
  for y in 0 ..< 20:
    for x in 0 ..< 20:
      # The deep viewport is at (2, 3) in the image: the outer one's corner.
      let inside = x >= 2 and x < 7 and y >= 3 and y < 7
      doAssert (image[x, y] == rgbx(0, 0, 255, 255)) == inside, $x & "," & $y
  doAssert not svg.coversOpaque(20, 20)
  let
    empty = parseSvg(el("svg", {"width": "20", "height": "20"}), 20, 20)
    found = damageRects(empty, svg, 20, 20)
  doAssert not found.full and found.rects == @[(2, 3, 5, 4)], $found

block: # A window repaint draws a clipped element as the whole render does
  let
    list = el("svg", {"x": "1", "y": "1", "width": "10", "height": "6", "viewBox": "0 3 10 6"},
      el("rect", {"x": "0", "y": "0", "width": "10", "height": "5", "fill": "#ff0000"}),
      el("rect", {"x": "0", "y": "5", "width": "10", "height": "5", "fill": "#00ff00"}))
    svg = parseSvg(el("svg", {"width": "12", "height": "8"}, list), 12, 8)
    whole = newImage(12, 8)
  svg.renderInto(whole)
  let parts = newImage(12, 8)
  svg.renderInto(parts.view(0, 0, 6, 8), 0, 0)
  svg.renderInto(parts.view(6, 0, 6, 8), 6, 0)
  doAssert same(whole, parts)
  doAssert whole[5, 1] == rgbx(255, 0, 0, 255) # y 3 of the content: red
  doAssert whole[5, 3] == rgbx(0, 255, 0, 255) # y 5: green
  doAssert whole[5, 7] == rgbx(0, 0, 0, 0)     # below the viewport

block: # A scrolled viewport's children, handed over again, keep their parse
  # A UI's scrolled list: the same child nodes inside a new viewport whose
  # viewBox alone moved. Drawn as a parse without reuse draws them, the
  # unmoved ones the same elements (no damage); a child with a viewport of
  # its own, whose clip a scroll changes, is parsed again.
  let
    rows = @[
      el("rect", {"x": "0", "y": "0", "width": "10", "height": "5", "fill": "#ff0000"}),
      el("rect", {"x": "0", "y": "5", "width": "10", "height": "5", "fill": "#00ff00"}),
      el("svg", {"x": "2", "y": "10", "width": "6", "height": "4"},
        el("rect", {"x": "0", "y": "0", "width": "20", "height": "20", "fill": "#0000ff"})),
      el("g", {"transform": "translate(1 15)"},
        el("rect", {"x": "0", "y": "0", "width": "8", "height": "3", "fill": "#ffff00"}))]
    list = proc(top: int): SvgNode =
      result = el("svg", {"x": "1", "y": "1", "width": "10", "height": "6", "viewBox": "0 " & $top & " 10 6"})
      result.children = rows
    doc = proc(top: int): SvgNode = el("svg", {"width": "12", "height": "8"}, list(top))
  discard parseSvg(doc(0), 12, 8, reuse = true)
  for top in [3, 3, 9, 12, 2]:
    let
      kept = parseSvg(doc(top), 12, 8, reuse = true)
      reused = newImage(12, 8)
      plain = newImage(12, 8)
    kept.renderInto(reused)
    parseSvg(doc(top), 12, 8).renderInto(plain)
    doAssert same(reused, plain), $top
  # Not moved: the very same elements, so no damage at all.
  let
    a = parseSvg(doc(4), 12, 8, reuse = true)
    b = parseSvg(doc(4), 12, 8, reuse = true)
  doAssert damageRects(a, b, 12, 8).rects.len == 0
  echo "svg viewport reuse ok"

block: # Long path data read when its element is drawn draws the same picture
  # A coastline: one subpath of relative lines, long past the path cache's
  # limit (a map's are 20-95 KB). With `lateData` its commands are made when
  # the element is drawn, not at the parse, and nothing else changes: the
  # fill, the stroke over it, a short path beside it, a window of the image
  # and the box it damages.
  var coast = "M10 100"
  for i in 0 ..< 6000:
    coast.add (if i mod 2 == 0: "l.03 -9" else: "l.03 9.02")
  coast.add "L190 190 10 190z"
  doAssert coast.len * 4 > 64 * 1024
  proc drawing(): SvgNode =
    el("svg", {"width": "200", "height": "200", "viewBox": "0 0 200 200"},
      el("rect", {"width": "200", "height": "200", "fill": "#f5f3ee"}),
      el("g", {"transform": "translate(0 -20)"},
        el("path", {"d": coast, "fill": "#a7d3f5", "stroke": "#4f86bd", "stroke-width": "1.5",
          "stroke-linejoin": "round"})),
      el("path", {"d": "M20 20h40v30z", "fill": "#e5484d"}))
  let
    early = parseSvg(drawing(), 200, 200)
    late = parseSvg(drawing(), 200, 200, lateData = true)
    whole = newImage(early)
  doAssert same(whole, newImage(late))
  doAssert whole[100, 120] == rgbx(167, 211, 245, 255) # inside the coast's fill
  doAssert late.coversOpaque(200, 200)
  # Drawn in two windows, each reading the data for itself. Within one
  # level, not the same: a window's rows are sampled at the same fifths of
  # a pixel, but a sloped edge's crossings are worked out in the window's
  # coordinates and may round the other way. This coast drew the same by
  # chance (with steps of .031 instead of .03 three pixels did not, before
  # round joins became arcs, 2026-11-25).
  let parts = newImage(200, 200)
  late.renderInto(parts.view(0, 0, 200, 90), 0, 0)
  late.renderInto(parts.view(0, 90, 200, 110), 0, 90)
  for y in 0 ..< 200:
    for x in 0 ..< 200:
      let (a, b) = (whole[x, y], parts[x, y])
      doAssert abs(a.r.int - b.r.int) <= 1 and abs(a.g.int - b.g.int) <= 1 and
        abs(a.b.int - b.b.int) <= 1 and a.a == b.a, $x & "," & $y
  # The same text is the same element, whichever way it was parsed twice.
  let
    empty = parseSvg(el("svg", {"width": "200", "height": "200"}), 200, 200)
    again = parseSvg(drawing(), 200, 200, lateData = true)
  doAssert damageRects(late, again, 200, 200).rects.len == 0
  doAssert damageRects(empty, late, 200, 200).rects == damageRects(empty, early, 200, 200).rects
  # A paint server's fill (strips, each asking for the outline) and a
  # translucent stroke draw the same too.
  proc shaded(): SvgNode =
    el("svg", {"width": "200", "height": "200", "viewBox": "0 0 200 200"},
      el("defs", newSeq[(string, string)](), el("linearGradient", {"id": "sea", "gradientUnits": "userSpaceOnUse",
        "x1": "0", "y1": "0", "x2": "0", "y2": "200"},
        el("stop", {"offset": "0", "stop-color": "#a7d3f5"}),
        el("stop", {"offset": "1", "stop-color": "#17385a"}))),
      el("path", {"d": coast, "fill": "url(#sea)", "stroke": "#4f86bd", "stroke-opacity": "0.5",
        "stroke-width": "2"}))
  doAssert same(newImage(parseSvg(shaded(), 200, 200)),
    newImage(parseSvg(shaded(), 200, 200, lateData = true)))
  # A caller that keeps what it parsed (`reuse`) keeps its paths parsed.
  let kept = drawing()
  doAssert same(whole, newImage(parseSvg(kept, 200, 200, reuse = true, lateData = true)))
  doAssert same(whole, newImage(parseSvg(kept, 200, 200, reuse = true, lateData = true)))

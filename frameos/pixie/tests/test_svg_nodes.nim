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
  doAssert slice[5, 5] == rgbx(255, 0, 0, 255)
  doAssert slice[6, 5] == rgbx(0, 0, 255, 255)
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

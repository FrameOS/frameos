import pixie, pixie/fileformats/svg, strformat, strutils

# `damage` and `renderInto` with an origin: an animation that repaints only
# the box that changed must leave its target as a whole render would, down to
# an antialiasing level at a shape's edge.
# The frames below move a logo-like group (fills, a translucent shadow, a
# stroke) over a full-canvas background, through two buffers in turn as a
# double-buffered LCD does, so each buffer is repainted against the frame it
# held two frames back.

const
  W = 160
  H = 120

proc frame(i: int, extra = ""): string =
  let
    x = (i * 7) mod 100
    y = (i * 5) mod 70
    color = ["#55dfff", "#ff72c8", "#b9ed67"][i div 4 mod 3]
  &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">""" &
    &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#090b14"/>""" &
    &"""<g transform="translate({x.float + 2.5:.2f} {y.float + 2.5:.2f}) scale(0.5)" opacity="0.32">""" &
    """<path d="M10 10C30 0 50 0 70 10L60 40H20Z" fill="#000"/></g>""" &
    &"""<g transform="translate({x.float:.2f} {y.float:.2f}) scale(0.5)">""" &
    &"""<path d="M10 10C30 0 50 0 70 10L60 40H20Z" fill="{color}"/>""" &
    """<circle cx="40" cy="25" r="6" fill="none" stroke="#fff" stroke-width="3"/></g>""" &
    extra & "</svg>"

proc fresh(doc: string, format: PixelFormat): Image =
  result =
    if format == pfRgb565: newImage565(W, H)
    else: newImage(W, H)
  if format == pfRgb565:
    result.ditherStores = true
  parseSvg(doc, W, H).renderInto(result)

proc animate(format: PixelFormat) =
  var
    buffers = [fresh(frame(0), format), fresh(frame(1), format)]
    held = [parseSvg(frame(0), W, H), parseSvg(frame(1), W, H)]
    repainted = 0
  for i in 2 ..< 40:
    let
      target = buffers[i mod 2]
      next = parseSvg(frame(i), W, H)
      box = damage(held[i mod 2], next, W, H)
    doAssert not box.full, &"frame {i}: comparable frames reported as full"
    if box.w > 0:
      next.renderInto(target.view(box.x, box.y, box.w, box.h), box.x, box.y)
      repainted += box.w * box.h
    held[i mod 2] = next
    let expected = fresh(frame(i), format)
    var nudged = 0
    for y in 0 ..< H:
      for x in 0 ..< W:
        let (got, want) = (target[x, y], expected[x, y])
        if got == want:
          continue
        # The window's translation is folded into each element's transform,
        # so a coordinate can round one float32 ulp off a whole render's and
        # an antialiased edge pixel one coverage level off. Nothing else may
        # differ, and nothing accumulates: the box is repainted whole.
        let step = if format == pfRgb565: 9 else: 1
        doAssert abs(got.r.int - want.r.int) <= step and abs(got.g.int - want.g.int) <= step and
          abs(got.b.int - want.b.int) <= step,
          &"{format} frame {i}: ({x}, {y}) is {got}, a whole render gives {want}"
        inc nudged
    doAssert nudged * 200 < W * H, &"{format} frame {i}: {nudged} pixels off by a rounding"
  # The point of it: well under the whole canvas per frame.
  doAssert repainted < 38 * W * H div 2, $repainted

animate(pfRgbx)
animate(pfRgb565)

block:
  # Nothing changed: an empty box. An element added is damage where it is
  # (the rest still match, in order); a changed gradient, the elements
  # filled with it.
  let a = parseSvg(frame(3), W, H)
  doAssert damage(a, parseSvg(frame(3), W, H), W, H) == (false, 0, 0, 0, 0)
  let added = damage(a, parseSvg(frame(3, "<rect width=\"4\" height=\"4\"/>"), W, H), W, H)
  doAssert not added.full and added.x == 0 and added.y == 0 and added.w <= 6 and added.h <= 6, $added
  let
    g1 = "<defs><linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"9\" y2=\"0\">" &
      "<stop offset=\"0\" stop-color=\"#000\"/><stop offset=\"1\" stop-color=\"#fff\"/></linearGradient></defs>" &
      "<rect width=\"9\" height=\"9\" fill=\"url(#g)\"/>"
    g2 = g1.replace("#fff", "#f00")
  let ramp = damage(parseSvg(frame(3, g1), W, H), parseSvg(frame(3, g2), W, H), W, H)
  doAssert not ramp.full and ramp.x == 0 and ramp.y == 0 and ramp.w <= 11 and ramp.h <= 11, $ramp
  doAssert damage(nil, a, W, H).full

block:
  # A slider: a track, a fill whose gradient stretches to its width, and a
  # knob at its end. Moving it repaints the fill and the knob, never the
  # rest of the frame, and each frame comes out as a whole render.
  proc slider(level: int): string =
    let w = 20 + level
    &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">""" &
      &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#090b14"/>""" &
      """<rect x="10" y="20" width="140" height="16" rx="8" fill="#334155"/>""" &
      &"""<defs><linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="{10 + w}" y2="0">""" &
      """<stop offset="0" stop-color="#0369a1"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>""" &
      &"""<rect x="10" y="20" width="{w}" height="16" rx="8" fill="url(#g0)"/>""" &
      &"""<circle cx="{10 + w - 8}" cy="28" r="6" fill="#fff"/>""" &
      """<rect x="10" y="60" width="60" height="30" rx="6" fill="#fcd34d"/></svg>"""
  var
    buffers = [fresh(slider(0), pfRgbx), fresh(slider(10), pfRgbx)]
    held = [parseSvg(slider(0), W, H), parseSvg(slider(10), W, H)]
  for i in 2 ..< 14:
    let
      level = (i * 37) mod 120
      target = buffers[i mod 2]
      next = parseSvg(slider(level), W, H)
      found = damageRects(held[i mod 2], next, W, H)
    doAssert not found.full
    for r in found.rects:
      # The track's row, never the card below it.
      doAssert r.y >= 17 and r.y + r.h <= 39, &"slider {level}: {r}"
      next.renderInto(target.view(r.x, r.y, r.w, r.h), r.x, r.y)
    held[i mod 2] = next
    let expected = fresh(slider(level), pfRgbx)
    var nudged = 0
    for y in 0 ..< H:
      for x in 0 ..< W:
        let (got, want) = (target[x, y], expected[x, y])
        if got == want:
          continue
        # An antialiased edge a rounding off, as above; nothing more.
        doAssert abs(got.r.int - want.r.int) <= 2 and abs(got.g.int - want.g.int) <= 2 and
          abs(got.b.int - want.b.int) <= 2, &"slider {level}: ({x}, {y}) is {got}, a whole render gives {want}"
        inc nudged
    doAssert nudged * 200 < W * H, &"slider {level}: {nudged} pixels off by a rounding"

block:
  # Identical path data is parsed once.
  let
    a = parseSvg(frame(5), W, H)
    b = parseSvg(frame(6), W, H)
  doAssert not damage(a, b, W, H).full


block:
  # damageRects: a switch in one corner and the count it updates in the
  # other are two small boxes, repainted alone (the windowed render skips
  # every element over neither), through three buffers in turn, and every
  # frame still equals a whole render.
  proc panel(i: int): string =
    let on = i mod 2 == 1
    var doc = &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">""" &
      &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#0f172a"/>"""
    for k in 0 ..< 6:
      let
        x = 8 + (k mod 3) * 50
        y = 40 + (k div 3) * 38
        fill = if k == 5 and on: "#fda4af" else: "#334155"
      doc.add &"""<rect x="{x}" y="{y}" width="44" height="32" rx="6" fill="{fill}"/>"""
      doc.add &"""<circle cx="{x + 34}" cy="{y + 10}" r="5" fill="#fff" stroke="#000" stroke-width="1"/>"""
    doc.add &"""<rect x="120" y="6" width="{8 + (i mod 4) * 6}" height="10" fill="#94a3b8"/>"""
    doc & "</svg>"
  var
    buffers = [fresh(panel(0), pfRgbx), fresh(panel(1), pfRgbx), fresh(panel(2), pfRgbx)]
    held = [parseSvg(panel(0), W, H), parseSvg(panel(1), W, H), parseSvg(panel(2), W, H)]
    twice = 0
  for i in 3 ..< 24:
    let
      target = buffers[i mod 3]
      next = parseSvg(panel(i), W, H)
      found = damageRects(held[i mod 3], next, W, H)
    doAssert not found.full
    if found.rects.len == 2:
      inc twice
      let union = damage(held[i mod 3], next, W, H)
      doAssert found.rects[0].w * found.rects[0].h + found.rects[1].w * found.rects[1].h < union.w * union.h div 2,
        &"frame {i}: two boxes {found.rects} cover half of one {union}"
    for r in found.rects:
      next.renderInto(target.view(r.x, r.y, r.w, r.h), r.x, r.y)
    held[i mod 3] = next
    let expected = fresh(panel(i), pfRgbx)
    for y in 0 ..< H:
      for x in 0 ..< W:
        let (got, want) = (target[x, y], expected[x, y])
        doAssert abs(got.r.int - want.r.int) <= 1 and abs(got.g.int - want.g.int) <= 1 and
          abs(got.b.int - want.b.int) <= 1, &"frame {i}: ({x}, {y}) is {got}, a whole render gives {want}"
  doAssert twice > 0
  # Capped: past maxRects the cheapest joins, and one box is damage's box.
  let
    a = parseSvg(panel(1), W, H)
    b = parseSvg(panel(2), W, H)
    one = damageRects(a, b, W, H, 1)
    box = damage(a, b, W, H)
  doAssert one.rects.len == 1 and one.rects[0] == (box.x, box.y, box.w, box.h)
  doAssert damageRects(a, a, W, H).rects.len == 0

block:
  # A check mark that comes and goes in the middle of a list (a to-do row
  # ticked): matched around, the rows that did not change are not damage,
  # and every frame repainted this way equals a whole render.
  proc rows(i: int): string =
    result = &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">""" &
      &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#f1f5f9"/>"""
    for k in 0 ..< 5:
      let y = 8 + k * 22
      result.add &"""<rect x="8" y="{y}" width="140" height="18" rx="4" fill="#fff"/>"""
      if (i + k) mod 4 == 0:
        result.add &"""<path d="M14 {y + 9}l4 4 8-8" fill="none" stroke="#10b981" stroke-width="2"/>"""
      result.add &"""<rect x="32" y="{y + 6}" width="{60 + k * 10}" height="6" fill="#334155"/>"""
    result.add "</svg>"
  var
    buffer = fresh(rows(0), pfRgbx)
    held = parseSvg(rows(0), W, H)
  for i in 1 ..< 12:
    let
      next = parseSvg(rows(i), W, H)
      found = damageRects(held, next, W, H)
    doAssert not found.full, &"frame {i}"
    var area = 0
    for r in found.rects:
      next.renderInto(buffer.view(r.x, r.y, r.w, r.h), r.x, r.y)
      area += r.w * r.h
    # Two rows' marks at most (one gone, one come), not the list between.
    doAssert area < W * H div 8, &"frame {i}: {area} pixels for {found.rects}"
    held = next
    let expected = fresh(rows(i), pfRgbx)
    for y in 0 ..< H:
      for x in 0 ..< W:
        let (got, want) = (buffer[x, y], expected[x, y])
        doAssert abs(got.r.int - want.r.int) <= 1 and abs(got.g.int - want.g.int) <= 1 and
          abs(got.b.int - want.b.int) <= 1, &"frame {i}: ({x}, {y}) is {got}, a whole render gives {want}"

block:
  # A stroke reaches past its path by how it joins and ends: a round join or
  # cap half the width, a square cap to its corners, a miter join as far as
  # its limit. Drawn over the same background, each one's damage box is
  # tight around its kind of reach and still holds every pixel it painted.
  const bg = &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#f1f5f9"/>"""
  proc doc(stroke = ""): string =
    &"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">{bg}{stroke}</svg>"""
  let empty = parseSvg(doc(), W, H)
  for (join, cap, reach) in [("round", "round", 0.5), ("bevel", "butt", 0.5),
      ("round", "square", 0.71), ("miter", "round", 2.0)]:
    # A sharp turn (a miter that reaches its limit) and two ends.
    let stroke = &"""<polyline points="30,90 80,30 90,90" fill="none" stroke="#ef4444" """ &
      &"""stroke-width="12" stroke-linejoin="{join}" stroke-linecap="{cap}" stroke-miterlimit="4"/>"""
    let
      next = parseSvg(doc(stroke), W, H)
      box = damage(empty, next, W, H)
      grow = (12 * reach + 2).ceil.int # the reach, antialiasing and rounding out
    doAssert not box.full and box.w > 0
    doAssert box.x >= 30 - grow - 1 and box.x + box.w <= 90 + grow + 1 and
      box.y >= 30 - grow - 1 and box.y + box.h <= 90 + grow + 1,
      &"{join}/{cap}: {box} reaches past {grow}"
    let target = fresh(doc(), pfRgbx)
    next.renderInto(target.view(box.x, box.y, box.w, box.h), box.x, box.y)
    let expected = fresh(doc(stroke), pfRgbx)
    for y in 0 ..< H:
      for x in 0 ..< W:
        doAssert target[x, y] == expected[x, y],
          &"{join}/{cap}: ({x}, {y}) is {target[x, y]} outside {box}, a whole render gives {expected[x, y]}"
  # A line from a finger, round-capped (its join the default miter, which a
  # single segment never draws): its box, not four widths more on each side.
  let
    lineDoc = doc("""<line x1="40" y1="60" x2="52" y2="62" stroke="#000" stroke-width="12" stroke-linecap="round"/>""")
    line = parseSvg(lineDoc, W, H)
    lineBox = damage(empty, line, W, H)
  doAssert lineBox.w * lineBox.h <= 30 * 22, &"{lineBox}"
  let lineTarget = fresh(doc(), pfRgbx)
  line.renderInto(lineTarget.view(lineBox.x, lineBox.y, lineBox.w, lineBox.h), lineBox.x, lineBox.y)
  let lineExpected = fresh(lineDoc, pfRgbx)
  for y in 0 ..< H:
    for x in 0 ..< W:
      doAssert lineTarget[x, y] == lineExpected[x, y], &"line: ({x}, {y}) outside {lineBox}"

block:
  # A window a 565 picture hides (a canvas over its page) draws the picture
  # alone: what is under it is not drawn at all, here a fill that would
  # raise if it were. A window reaching past the picture draws everything
  # there, and both equal a whole render.
  let picture = newImage565(80, 60)
  for y in 0 ..< 60:
    for x in 0 ..< 80:
      picture[x, y] = rgba((x * 3).uint8, (y * 4).uint8, 200, 255)
  proc page(under: string): Svg =
    let root = parseSvgNodes(&"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">""" &
      &"""<rect x="0" y="0" width="{W}" height="{H}" fill="#0b1020"/>""" &
      """<rect x="10" y="10" width="100" height="80" rx="8" fill="#f1f5f9"/>""" & under &
      """<image x="20" y="20" width="80" height="60" preserveAspectRatio="none"/>""" &
      """<circle cx="90" cy="70" r="6" fill="#ef4444"/></svg>""")
    for child in root.children:
      if child.tag == "image":
        child.image = picture
    parseSvg(root, W, H)
  let
    raising = page("""<rect x="30" y="30" width="40" height="30" fill="url(#nowhere)"/>""")
    plain = page("")
    expected = newImage(W, H)
  plain.renderInto(expected)
  var hidden = newImage(W, H)
  plain.renderInto(hidden)
  hidden.fill(rgba(0, 0, 0, 0))
  # Inside the picture, the red dot over it included: only the picture and
  # the dot draw.
  raising.renderInto(hidden.view(25, 25, 70, 50), 25, 25)
  for y in 25 ..< 75:
    for x in 25 ..< 95:
      doAssert hidden[x, y] == expected[x, y], &"({x}, {y}) is {hidden[x, y]}, a whole render gives {expected[x, y]}"
  # Past the picture's edge the page shows, so it is drawn (and raises).
  var raised = false
  try:
    raising.renderInto(hidden.view(15, 25, 30, 20), 15, 25)
  except PixieError:
    raised = true
  doAssert raised
  plain.renderInto(hidden.view(15, 15, 90, 70), 15, 15)
  for y in 15 ..< 85:
    for x in 15 ..< 105:
      doAssert hidden[x, y] == expected[x, y], &"({x}, {y}) is {hidden[x, y]}, a whole render gives {expected[x, y]}"

echo "svg damage ok"

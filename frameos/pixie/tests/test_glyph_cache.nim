## The glyph cache (paths.nim): text drawn from kept glyph coverage paints
## what its outlines paint, on every surface and through a view; a glyph
## drawn again is a hit; the budget holds, least recently used out first;
## what the cache cannot do exactly is filled from the outline. The masks are
## four bits a pixel, so an edge pixel's coverage can move by up to half a
## step of sixteen (8 of 255), plus a unit of float rounding.

import pixie, pixie/paths, pixie/fileformats/svg, std/unicode

let typeface = readTypeface("tests/fonts/Roboto-Regular_1.ttf")

proc font(size: float32, color = rgba(20, 30, 40, 255)): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color.color

proc maxDiff(a, b: Image): int =
  doAssert a.width == b.width and a.height == b.height
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        p = a.unsafe[x, y]
        q = b.unsafe[x, y]
      let d = max(abs(p.r.int - q.r.int), max(abs(p.g.int - q.g.int),
        max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int))))
      result = max(result, d)

proc differing(a, b: Image, by = 0): int =
  ## Pixels where a channel differs by more than `by`.
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        p = a.unsafe[x, y]
        q = b.unsafe[x, y]
      if max(abs(p.r.int - q.r.int), max(abs(p.g.int - q.g.int), max(abs(p.b.int - q.b.int),
          abs(p.a.int - q.a.int)))) > by:
        inc result

proc make(kind: string): Image =
  case kind
  of "565": newImage565(320, 120)
  of "gray8": newImageGray8(320, 120)
  of "gray4": newImageGray4(320, 120)
  else: newImage(320, 120)

proc tolerance(kind: string): int =
  ## Half a step of sixteen and a rounding unit; a 565 channel's step is 8
  ## and a sixteen-grey panel's 17, and an edge can land on either side.
  case kind
  of "565": 16
  of "gray4": 17
  else: 10

const sample = "Glyphs, cached: 0123 Wave AV."

proc drawGlyphs(target: Image, view: bool, size: float32, at: Vec2, outlines: bool) =
  ## The sample's glyphs one by one at quarter pixels, as glyph paths or as
  ## their outlines: what is compared is the coverage alone.
  var image = target
  if view:
    image = target.view(6, 6, target.width - 12, target.height - 12)
  let shift = if view: vec2(-6, -6) else: vec2(0, 0)
  image.fill(rgba(255, 255, 255, 255))
  for (line, ink, scaleBy) in [(0, rgba(20, 30, 40, 255), 1'f32), (1, rgba(200, 30, 30, 160), 0.6'f32)]:
    let f = font(size * scaleBy)
    let arrangement = f.typeset(sample)
    for i, rune in arrangement.runes:
      let path = typeface.glyphPath(rune, f.size)
      if path.isNil:
        continue
      let p = arrangement.positions[i]
      let m = translate(at + shift + vec2(round(p.x * 4) / 4, round(p.y * 4) / 4 + line.float32 * round(size * 1.4)))
      if outlines:
        image.fillPath(path.glyphOutline(), ink, m)
      else:
        image.fillPath(path, ink, m)

proc draw(target: Image, view: bool, size: float32, at: Vec2) =
  var image = target
  if view:
    image = target.view(6, 6, target.width - 12, target.height - 12)
  let shift = if view: vec2(-6, -6) else: vec2(0, 0)
  image.fill(rgba(255, 255, 255, 255))
  image.fillText(font(size).typeset(sample), translate(at + shift))
  image.fillText(font(size * 0.6, rgba(200, 30, 30, 160)).typeset("translucent ink"),
    translate(at + shift + vec2(10, size * 1.4)))

# Parity with the outlines, hits on the second draw, on every surface.
for kind in ["rgbx", "565", "gray8", "gray4"]:
  for view in [false, true]:
    let at = vec2(4.25, 6.5)
    glyphCacheBudget = 256 * 1024
    clearGlyphCache()
    let plain = make(kind)
    plain.drawGlyphs(view, 22, at, outlines = true)
    doAssert glyphCacheEntries() == 0
    glyphCacheHits = 0
    glyphCacheMisses = 0
    let cached = make(kind)
    cached.drawGlyphs(view, 22, at, outlines = false)
    let misses = glyphCacheMisses
    doAssert misses > 0
    let diff = maxDiff(plain, cached)
    doAssert diff <= tolerance(kind), kind & " view=" & $view & ": differs from the outlines by " & $diff
    # Most edge pixels move by a step of sixteen or less (two of 565's), hardly
    # any by more. A sixteen-grey surface dithers: there a coverage a step
    # apart can land a level apart, and nothing lands further.
    let by = case kind
      of "565": tolerance(kind) - 1
      of "gray4": tolerance(kind)
      else: 9
    doAssert differing(plain, cached, by) <= plain.width * plain.height div 400,
      kind & ": " & $differing(plain, cached, by) & " pixels differ by more than " & $by
    let again = make(kind)
    again.drawGlyphs(view, 22, at, outlines = false)
    doAssert glyphCacheMisses == misses, "the second draw is all hits"
    doAssert glyphCacheHits >= misses
    doAssert maxDiff(cached, again) == 0
    # fillText draws from the cache too: every glyph a hit now.
    let before = glyphCacheMisses
    let text = make(kind)
    text.draw(view, 22, at)
    doAssert glyphCacheHits > misses
    discard before
    clearGlyphCache()
    doAssert glyphCacheUsedBytes() == 0 and glyphCacheEntries() == 0

# fillText against its outlines: a glyph lands at the nearest quarter pixel,
# an eighth of one away at most, which moves an edge pixel by an eighth of
# full ink across and, vertically, can move it across one of the filler's
# five sub-scanlines (a fifth of full ink). A few pixels, by that much.
for kind in ["rgbx", "565", "gray8"]:
  glyphCacheBudget = 0
  let plain = make(kind)
  plain.draw(false, 22, vec2(4.37, 6.11))
  glyphCacheBudget = 256 * 1024
  clearGlyphCache()
  let cached = make(kind)
  cached.draw(false, 22, vec2(4.37, 6.11))
  doAssert maxDiff(plain, cached) <= 64 + tolerance(kind), kind & ": " & $maxDiff(plain, cached)
  doAssert differing(plain, cached, by = 16 + tolerance(kind)) <= plain.width * plain.height div 100,
    kind & ": " & $differing(plain, cached, by = 16 + tolerance(kind)) & " pixels differ"

# The same glyph at a size, a fraction and a face is one entry, wherever it
# lands: "aaaa" set four times at whole-pixel steps is one mask.
block:
  glyphCacheBudget = 64 * 1024
  clearGlyphCache()
  glyphCacheHits = 0
  glyphCacheMisses = 0
  let image = make("rgbx")
  let path = typeface.glyphPath(Rune('a'), 20)
  for i in 0 ..< 4:
    image.fillPath(path, rgba(0, 0, 0, 255), translate(vec2(10 + i.float32 * 15, 30)))
  doAssert glyphCacheMisses == 1 and glyphCacheHits == 3
  doAssert glyphCacheEntries() == 1
  # Another quarter is another mask, another size another.
  image.fillPath(path, rgba(0, 0, 0, 255), translate(vec2(80.25, 30)))
  image.fillPath(typeface.glyphPath(Rune('a'), 21), rgba(0, 0, 0, 255), translate(vec2(100, 30)))
  doAssert glyphCacheEntries() == 3
  # A scale is a size: the glyph at 20 px scaled by 2 is the 40 px mask.
  image.fillPath(path, rgba(0, 0, 0, 255), translate(vec2(120, 30)) * scale(vec2(2, 2)))
  image.fillPath(typeface.glyphPath(Rune('a'), 40), rgba(0, 0, 0, 255), translate(vec2(180, 30)))
  doAssert glyphCacheEntries() == 4, $glyphCacheEntries()
  # A glyph path is the same element as another of the same glyph and no
  # other (svg damage compares elements by their commands).
  doAssert sameCommands(path, typeface.glyphPath(Rune('a'), 20))
  doAssert not sameCommands(path, typeface.glyphPath(Rune('b'), 20))
  doAssert not sameCommands(path, typeface.glyphPath(Rune('a'), 21))

# The budget: least recently used out first, never over.
block:
  glyphCacheBudget = 4 * 1024
  clearGlyphCache()
  let image = make("rgbx")
  var recent: seq[Path]
  for c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ":
    let path = typeface.glyphPath(Rune(c), 24)
    image.fillPath(path, rgba(0, 0, 0, 255), translate(vec2(20, 40)))
    doAssert glyphCacheUsedBytes() <= glyphCacheBudget
    recent.add path
  doAssert glyphCacheEntries() < 52, "4 KB does not hold 52 glyphs at 24 px"
  let kept = glyphCacheEntries()
  # The newest are kept, the oldest went.
  glyphCacheHits = 0
  glyphCacheMisses = 0
  image.fillPath(recent[^1], rgba(0, 0, 0, 255), translate(vec2(20, 40)))
  image.fillPath(recent[^2], rgba(0, 0, 0, 255), translate(vec2(20, 40)))
  doAssert glyphCacheHits == 2 and glyphCacheMisses == 0
  image.fillPath(recent[0], rgba(0, 0, 0, 255), translate(vec2(20, 40)))
  doAssert glyphCacheMisses == 1
  # A hit makes an entry the newest: drawn again now, `Z` outlives the rest.
  for i in 0 ..< kept * 2:
    image.fillPath(recent[^1], rgba(0, 0, 0, 255), translate(vec2(20, 40)))
    image.fillPath(recent[i mod 26], rgba(0, 0, 0, 255), translate(vec2(20, 40)))
  glyphCacheMisses = 0
  image.fillPath(recent[^1], rgba(0, 0, 0, 255), translate(vec2(20, 40)))
  doAssert glyphCacheMisses == 0
  doAssert glyphCacheUsedBytes() <= glyphCacheBudget

# What the cache cannot do exactly is the outline, pixel for pixel.
block:
  glyphCacheBudget = 256 * 1024
  clearGlyphCache()
  glyphCacheHits = 0
  glyphCacheMisses = 0
  let
    rotated = rotate(0.3'f32) * translate(vec2(0, 0))
    m = translate(vec2(60, 20)) * rotated
    arrangement = font(26).typeset("Rotated")
  let viaCache = make("rgbx")
  viaCache.fill(rgba(255, 255, 255, 255))
  viaCache.fillText(arrangement, m)
  glyphCacheBudget = 0
  let viaOutline = make("rgbx")
  viaOutline.fill(rgba(255, 255, 255, 255))
  viaOutline.fillText(arrangement, m)
  doAssert maxDiff(viaCache, viaOutline) == 0
  glyphCacheBudget = 256 * 1024
  doAssert glyphCacheHits == 0 and glyphCacheMisses == 0
  # A glyph path under a rotation, or in a gradient, or stroked: its outline.
  let path = typeface.glyphPath(Rune('R'), 40)
  let a = make("rgbx")
  a.fillPath(path, rgba(0, 0, 0, 255), translate(vec2(40, 60)) * rotate(0.2'f32))
  let b = make("rgbx")
  b.fillPath(path.glyphOutline(), rgba(0, 0, 0, 255), translate(vec2(40, 60)) * rotate(0.2'f32))
  doAssert maxDiff(a, b) == 0
  let gradient = newPaint(LinearGradientPaint)
  gradient.gradientHandlePositions = @[vec2(0, 0), vec2(100, 0)]
  gradient.gradientStops = @[ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(0, 0, 1, 1), position: 1)]
  let c = make("rgbx")
  c.fillPath(path, gradient, translate(vec2(40, 60)))
  let d = make("rgbx")
  d.fillPath(path.glyphOutline(), gradient, translate(vec2(40, 60)))
  doAssert maxDiff(c, d) == 0
  let e = make("rgbx")
  e.strokePath(path, rgba(0, 0, 0, 255), translate(vec2(40, 60)), strokeWidth = 2)
  let f = make("rgbx")
  f.strokePath(path.glyphOutline(), rgba(0, 0, 0, 255), translate(vec2(40, 60)), strokeWidth = 2)
  doAssert maxDiff(e, f) == 0
  doAssert glyphCacheHits == 0 and glyphCacheMisses == 0
  # A glyph larger than a mask is kept for: its outline.
  let huge = typeface.glyphPath(Rune('W'), 400)
  let g = newImage(500, 500)
  g.fillPath(huge, rgba(0, 0, 0, 255), translate(vec2(20, 420)))
  let h = newImage(500, 500)
  h.fillPath(huge.glyphOutline(), rgba(0, 0, 0, 255), translate(vec2(20, 420)))
  doAssert maxDiff(g, h) == 0
  doAssert glyphCacheEntries() == 0

# A glyph path's bounds hold its outline (they are the font's stated box).
block:
  for c in "AgjQ@W|,.":
    let path = typeface.glyphPath(Rune(c), 33)
    let b = path.localBounds()
    let o = path.glyphOutline().computeBounds()
    doAssert o.x >= b.x - 0.01 and o.y >= b.y - 0.01 and
      o.x + o.w <= b.x + b.w + 0.01 and o.y + o.h <= b.y + b.h + 0.01, $c & ": " & $b & " vs " & $o
  doAssert typeface.glyphPath(Rune(' '), 20).isNil

# SVG text in one colour is glyph paths, drawn from the cache, like the
# outlines; with a stroke it is the outline as before.
block:
  setSvgTypefaceResolver(proc(family: string, weight: int, italic: bool): Typeface {.gcsafe, raises: [].} =
    {.cast(gcsafe).}: typeface)
  let markup = """<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120">
    <rect width="320" height="120" fill="#fff"/>
    <text x="10.25" y="40" font-size="28" fill="#123456">Hello SVG text</text>
    <text x="10" y="90" font-size="24" fill="#a00" stroke="#000" stroke-width="1">stroked</text>
  </svg>"""
  glyphCacheBudget = 0
  let plain = newImage(320, 120)
  parseSvg(markup).renderInto(plain)
  glyphCacheBudget = 256 * 1024
  clearGlyphCache()
  glyphCacheMisses = 0
  let cached = newImage(320, 120)
  parseSvg(markup).renderInto(cached)
  doAssert glyphCacheMisses > 0
  # Its glyphs land at quarter pixels, as fillText's do.
  doAssert maxDiff(plain, cached) <= 64 + tolerance("rgbx"), $maxDiff(plain, cached)
  doAssert differing(plain, cached, by = 16 + tolerance("rgbx")) <= plain.width * plain.height div 100

# A render larger than the budget: with a pass per render, the glyphs that fit
# stay and the rest are drawn from masks made and let go; plain LRU puts out
# each glyph just before it is drawn again and keeps nothing a render can use.
# Last: a pass, once started, stays on for the thread.
block:
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  var paths: seq[Path]
  for c in letters:
    paths.add typeface.glyphPath(Rune(c), 24)
  proc render(image: Image) =
    for i, path in paths:
      image.fillPath(path, rgba(0, 0, 0, 255), translate(vec2(10 + float32(i mod 13) * 24, 30 + float32(i div 13) * 28)))
  glyphCacheBudget = 256 * 1024
  clearGlyphCache()
  let whole = make("gray4")
  whole.render()
  doAssert glyphCacheEntries() == letters.len
  let needs = glyphCacheUsedBytes()

  glyphCacheBudget = needs div 2
  clearGlyphCache()
  for i in 0 ..< 3:
    glyphCacheHits = 0
    glyphCacheMisses = 0
    make("gray4").render()
    doAssert glyphCacheUsedBytes() <= glyphCacheBudget
  doAssert glyphCacheHits == 0, "plain LRU, a render over the budget: " & $glyphCacheHits

  clearGlyphCache()
  var last: Image
  for i in 0 ..< 3:
    newGlyphCachePass()
    glyphCacheHits = 0
    glyphCacheMisses = 0
    last = make("gray4")
    last.render()
    doAssert glyphCacheUsedBytes() <= glyphCacheBudget
  doAssert glyphCacheHits >= letters.len div 3, "with passes: " & $glyphCacheHits & " hits"
  doAssert glyphCacheHits + glyphCacheMisses == letters.len
  # A glyph drawn from a mask not kept paints what a kept one does.
  doAssert maxDiff(whole, last) == 0

glyphCacheBudget = 0
clearGlyphCache()
echo "glyph cache: ok"

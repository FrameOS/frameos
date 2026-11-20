import std/unittest
import pixie
import pixie/paths
import pixie/fileformats/svg
import frameos/utils/font # installs the typeface resolver text uses
import frameos/ui/layout

# A UI's text is glyph paths (pixie's `glyphPath`: no outline kept), drawn
# from pixie's glyph cache: the picture is the outlines' within a step of
# the cache's sixteen coverage levels, a letter used twice is one mask, and
# with the cache off the same nodes draw from outlines made per fill.

proc el(tag, classes: string, children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  if classes.len > 0:
    result.attrs.add(("class", classes))
  for child in children:
    result.children.add child

proc txt(text: string): SvgNode = SvgNode(text: text)

proc ui(): SvgNode =
  el("div", "w-full h-full bg-white p-3 flex flex-col gap-2",
    el("div", "text-2xl text-slate-900", txt("Glyphs from the cache")),
    el("div", "text-sm text-slate-600", txt("every letter a kept mask, eeee")),
    el("div", "text-4xl font-bold text-sky-700", txt("21.5°")))

proc draw(canvas: Image, root: SvgNode): SvgNode =
  var input: UiInput
  var regions: seq[UiRegion]
  result = layoutUi(root, canvas.width, canvas.height, input, regions)
  parseSvg(result, canvas.width, canvas.height).renderInto(canvas)

proc glyphNodes(svg: SvgNode): seq[SvgNode] =
  for node in svg.children:
    if not node.path.isNil and node.path.isGlyph:
      result.add node
    result.add node.glyphNodes()

proc maxDiff(a, b: Image): int =
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        p = a.unsafe[x, y]
        q = b.unsafe[x, y]
      result = max(result, max(abs(p.r.int - q.r.int), max(abs(p.g.int - q.g.int), abs(p.b.int - q.b.int))))

suite "glyph runs":
  test "text is glyph paths, drawn from the glyph cache like its outlines":
    let previous = glyphCacheBudget
    defer:
      glyphCacheBudget = previous
      clearGlyphCache()
    for kind in ["rgbx", "565"]:
      proc make(): Image =
        if kind == "565": newImage565(320, 160) else: newImage(320, 160)
      glyphCacheBudget = 0
      clearGlyphCache()
      let plain = make()
      let svg = plain.draw(ui())
      let glyphs = svg.glyphNodes()
      check glyphs.len > 40
      check glyphCacheEntries() == 0
      glyphCacheBudget = 64 * 1024
      glyphCacheHits = 0
      glyphCacheMisses = 0
      let cached = make()
      discard cached.draw(ui())
      # Glyphs are placed at quarter pixels by the layout, so what differs is
      # the coverage's four bits: half a step of sixteen a fill, twice where
      # the bold line's double strike fills a pixel again, a 565 channel's
      # step on top.
      check maxDiff(plain, cached) <= (if kind == "565": 24 else: 18)
      # "eeee" and the rest: far fewer masks than glyphs drawn, and the
      # bold line's double strike reuses its glyphs' masks.
      check glyphCacheMisses < glyphs.len
      check glyphCacheHits > 0
      check glyphCacheUsedBytes() <= glyphCacheBudget
      let misses = glyphCacheMisses
      let again = make()
      discard again.draw(ui())
      check glyphCacheMisses == misses
      check maxDiff(cached, again) == 0

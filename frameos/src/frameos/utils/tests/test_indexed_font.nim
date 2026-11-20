import std/[unittest, unicode]
import pixie
import pixie/paths
import frameos/utils/font

# The built-in face is compiled in as an indexed font (tools/
# generate_indexed_font.py) and read where it lies: it must set and draw
# exactly as the TrueType font it was made from, and holding it must cost
# next to nothing.

let ttf = parseTtf(readFile("assets/compiled/fonts/Ubuntu-Regular.ttf"))

iterator runesToCompare(): Rune =
  for r in 0 .. 0x2FFF:
    yield Rune(r)
  for r in 0xFB00 .. 0xFFFF:
    yield Rune(r)

suite "the indexed default font":
  test "it is held in place: the built-in face costs next to nothing":
    let previous = glyphCacheBudget
    defer: glyphCacheBudget = previous
    glyphCacheBudget = 0
    let image = newImage(200, 60)
    GC_fullCollect()
    let before = getOccupiedMem()
    let face = getDefaultTypeface() # the first use in this test binary
    GC_fullCollect()
    let made = getOccupiedMem() - before
    # Its few fields, and the cache's table entry: the file stays where the
    # compiler put it (a parsed TrueType face held 162 KB).
    check made < 1024
    # Drawing text inflates the glyphs' blocks into a two-block cache, ~2 KB
    # each, and keeps nothing else of the font (the rest is the allocator's
    # rounding).
    image.fillText(newFont(face, 20, parseHtmlColor("#000")).typeset("Held in place, read a glyph at a time"))
    GC_fullCollect()
    check getOccupiedMem() - before < 8 * 1024

  test "metrics, the character map and the advances are the TrueType font's":
    let face = getDefaultTypeface()
    check face.scale == ttf.scale
    check face.ascent == ttf.ascent
    check face.descent == ttf.descent
    check face.lineGap == ttf.lineGap
    check face.capHeight == ttf.capHeight
    var mapped = 0
    for rune in runesToCompare():
      check face.hasGlyph(rune) == ttf.hasGlyph(rune)
      if ttf.hasGlyph(rune):
        inc mapped
        check face.getAdvance(rune) == ttf.getAdvance(rune)
    check mapped > 1000

  test "every outline is the TrueType font's, command for command":
    let face = getDefaultTypeface()
    for rune in runesToCompare():
      if not ttf.hasGlyph(rune):
        continue
      let
        a = face.getGlyphPath(rune)
        b = ttf.getGlyphPath(rune)
      if not sameCommands(a, b):
        checkpoint "U+" & $rune.int
        check false
      # The glyph path's box (the font's, rounded outwards) holds the outline.
      let glyph = face.glyphPath(rune, 40)
      if not glyph.isNil:
        let
          box = glyph.localBounds()
          o = glyph.glyphOutline().computeBounds()
        check o.x >= box.x - 0.01 and o.y >= box.y - 0.01
        check o.x + o.w <= box.x + box.w + 0.01 and o.y + o.h <= box.y + box.h + 0.01

  test "kerning is the TrueType font's":
    let face = getDefaultTypeface()
    var kerned = 0
    for l in 0x20 .. 0x24F:
      for r in 0x20 .. 0x24F:
        let
          left = Rune(l)
          right = Rune(r)
          expected = ttf.getKerningAdjustment(left, right)
        if expected != 0:
          inc kerned
        if face.getKerningAdjustment(left, right) != expected:
          checkpoint "U+" & $l & " U+" & $r
          check false
    check kerned > 1000
    # Cyrillic and Greek too, a sample.
    for l in 0x391 .. 0x44F:
      for r in [0x41F, 0x422, 0x423, 0x3A4, 0x3A5, 0x2E, 0x2C]:
        check face.getKerningAdjustment(Rune(l), Rune(r)) == ttf.getKerningAdjustment(Rune(l), Rune(r))

  test "text sets and draws exactly as the TrueType font":
    let previous = glyphCacheBudget
    defer: glyphCacheBudget = previous
    glyphCacheBudget = 0 # outlines both
    const text = "Wave AVAST, To. Typeset — Ünïcödé Ω Ж fi 1234567890"
    let
      a = newFont(getDefaultTypeface(), 27, parseHtmlColor("#123"))
      b = newFont(ttf, 27, parseHtmlColor("#123"))
      ta = a.typeset(text, bounds = vec2(300, 200))
      tb = b.typeset(text, bounds = vec2(300, 200))
    check ta.positions == tb.positions
    check ta.lines == tb.lines
    let ia = newImage(320, 200)
    let ib = newImage(320, 200)
    ia.fillText(ta, translate(vec2(5.5, 4)))
    ib.fillText(tb, translate(vec2(5.5, 4)))
    var differing = 0
    for y in 0 ..< ia.height:
      for x in 0 ..< ia.width:
        if ia.unsafe[x, y] != ib.unsafe[x, y]:
          inc differing
    check differing == 0

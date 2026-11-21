import std/[algorithm, os, strutils, unittest, unicode]
import pixie
import pixie/paths
import pixie/fontformats/filefont
import pixie/fileformats/svg
import frameos/utils/font

# A font on an ESP32's SD card is the TrueType file itself, read where it lies
# (pixie/fontformats/filefont.nim, docs/esp32-fonts.md): it must set and draw
# exactly as pixie's whole parse of the same file, for every font FrameOS
# ships (assets/copied/fonts, the collection "Sync fonts" puts on a card),
# and holding one must cost next to nothing beyond the page cache.

let fontsDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "assets" / "copied" / "fonts"

proc shippedFonts(): seq[string] =
  for kind, path in walkDir(fontsDir):
    if kind == pcFile and path.endsWith(".ttf") and not path.endsWith("NotoColorEmoji.ttf"):
      result.add path
  result.sort()

iterator sampleRunes(): Rune =
  for r in 0x20 .. 0x52F: # Latin, Greek, Cyrillic
    yield Rune(r)
  for r in [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x20AC, 0x2122,
      0xFB01, 0xFB02, 0x1F600, 0x10FFFF, 0xFFFF, 0xFFFE]:
    yield Rune(r)

suite "TrueType fonts read where they lie":
  test "every shipped font is read in place, the emoji bitmaps too, and a CFF font is refused":
    let fonts = shippedFonts()
    check fonts.len >= 60
    for path in fonts:
      let face = openTypefaceFile(path)
      check face.scale > 0
    let emoji = openTypefaceFile(fontsDir / "NotoColorEmoji.ttf")
    check emoji.hasColorGlyph(Rune(0x1F600))
    check not emoji.hasColorGlyph(Rune('A'))
    let cff = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "pixie" / "tests" / "fonts" / "Inter-Bold.ttf"
    try:
      discard openTypefaceFile(cff)
      check false
    except PixieError as e:
      check "CFF outlines" in e.msg and "font_for_card.py" in e.msg

  test "metrics, the character map, advances and boxes are pixie's":
    for path in shippedFonts():
      checkpoint path
      let
        file = openTypefaceFile(path)
        whole = parseTtf(readFile(path))
      check file.scale == whole.scale
      check file.ascent == whole.ascent
      check file.descent == whole.descent
      check file.lineGap == whole.lineGap
      check file.capHeight == whole.capHeight
      for rune in sampleRunes():
        if file.hasGlyph(rune) != whole.hasGlyph(rune):
          checkpoint "U+" & toHex(rune.int, 4)
          check false
        check file.getAdvance(rune) == whole.getAdvance(rune)

  test "outlines are pixie's, command for command, inside their boxes":
    for path in shippedFonts():
      checkpoint path
      let
        file = openTypefaceFile(path)
        whole = parseTtf(readFile(path))
      var n = 0
      for rune in sampleRunes():
        inc n
        if n mod 3 != 0 or not whole.hasGlyph(rune):
          continue # a third of them: 61 fonts
        let
          a = file.getGlyphPath(rune)
          b = whole.getGlyphPath(rune)
        if not sameCommands(a, b):
          checkpoint "U+" & toHex(rune.int, 4)
          check false
        let ga = file.glyphPath(rune, 40)
        let gb = whole.glyphPath(rune, 40)
        check ga.isNil == gb.isNil
        if not ga.isNil and not gb.isNil:
          check ga.localBounds() == gb.localBounds()

  test "kerning is pixie's":
    const pairs = "AVATAWAYFaLTPaTaToVaWaYaYoav\"A.,'Ly-T(f)fi" &
      "ЛАГаТоУаЭЖΑΥΤαΓΑ«»"
    let runes = toRunes(pairs)
    for path in shippedFonts():
      checkpoint path
      let
        file = openTypefaceFile(path)
        whole = parseTtf(readFile(path))
      var kerned = 0
      for left in runes:
        for right in runes:
          let expected = whole.getKerningAdjustment(left, right)
          if expected != 0:
            inc kerned
          if file.getKerningAdjustment(left, right) != expected:
            checkpoint $left & $right
            check false
      for l in 0x20 .. 0x7E:
        for r in 0x41 .. 0x5A:
          check file.getKerningAdjustment(Rune(l), Rune(r)) ==
            whole.getKerningAdjustment(Rune(l), Rune(r))

  test "text sets and draws exactly as pixie's whole parse":
    let previous = glyphCacheBudget
    defer: glyphCacheBudget = previous
    glyphCacheBudget = 0 # outlines both
    const text = "Wave AVAST, To. Typeset — Ünïcödé Ω Ж fi 1234567890"
    for name in ["CormorantGaramond-BoldItalic.ttf", "FiraGO-Regular.ttf",
        "LiberationSerif-Regular.ttf", "Galindo-Regular.ttf", "CascadiaMono.ttf"]:
      checkpoint name
      let path = fontsDir / name
      let
        a = newFont(openTypefaceFile(path))
        b = newFont(parseTtf(readFile(path)))
      a.size = 27
      b.size = 27
      a.paint = parseHtmlColor("#123")
      b.paint = parseHtmlColor("#123")
      let
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

  test "an open face holds next to nothing, and drawing holds only the page cache":
    let previous = glyphCacheBudget
    defer: glyphCacheBudget = previous
    glyphCacheBudget = 0
    clearFontPages()
    fileFontPages = 16
    let image = newImage(400, 80)
    GC_fullCollect()
    let before = getOccupiedMem()
    var faces: seq[Typeface]
    for path in shippedFonts():
      faces.add openTypefaceFile(path)
    GC_fullCollect()
    let opened = getOccupiedMem() - before
    # Sixty-odd faces: each its fields, its path and its pair tables' places,
    # and the page cache (16 pages of 512 bytes) the headers were read through.
    check opened < faces.len * 1024 + 16 * 512 + 4096
    let pagesBefore = fontPagesHeldBytes()
    for face in faces:
      let font = newFont(face)
      font.size = 18
      image.fillText(font.typeset("Held in place, Ωμέγα Жж"))
    GC_fullCollect()
    # Every face drew text, and what stays is the faces, the page cache and
    # its three tables (a rune's glyph, a glyph's advance and box, a pair's
    # kerning: 14 KB beside 16 pages of 1 KB): no outline, no font table.
    check fontPagesHeldBytes() < 32 * 1024
    check getOccupiedMem() - before < opened + (fontPagesHeldBytes() - pagesBefore) + 8192
    releaseFontFiles()

  test "a paragraph set again reads (almost) nothing from the file":
    clearFontPages()
    fileFontPages = 16
    let previous = glyphCacheBudget
    defer: glyphCacheBudget = previous
    glyphCacheBudget = 128 * 1024
    const para = "The quick brown fox jumps over the lazy dog. Pack my box with five " &
      "dozen liquor jugs! 0123456789 — “Quotes”, café, naïve, Ωμέγα, Жизнь."
    for name in ["Ubuntu-Regular.ttf", "FiraGO-Regular.ttf", "CormorantGaramond-Regular.ttf"]:
      checkpoint name
      let font = newFont(openTypefaceFile(fontsDir / name))
      font.size = 20
      let image = newImage(800, 300)
      image.fillText(font.typeset(para, bounds = vec2(780, 280)))
      fileFontPageReads = 0
      image.fillText(font.typeset(para, bounds = vec2(780, 280)))
      # Without the tables a 16-page cache read Ubuntu's GPOS 800 times over.
      check fileFontPageReads < 120
    releaseFontFiles()

  test "a face notices its file changed":
    let dir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "build" / "test-file-font"
    createDir(dir)
    defer: removeDir(dir)
    let path = dir / "Face.ttf"
    copyFile(fontsDir / "Galindo-Regular.ttf", path)
    clearFontPages()
    let face = openTypefaceFile(path)
    check face.hasGlyph(Rune('A'))
    check not face.isStale
    releaseFontFiles()
    copyFile(fontsDir / "Peralta-Regular.ttf", path)
    # A page not read yet opens the file again, which is another file now:
    # nothing of it is read through this face's tables, and the face says so.
    discard face.getGlyphPath(Rune('Z'))
    check face.isStale

suite "the frame's fonts, read in place":
  let assets = fontsDir.parentDir()

  test "fileTypeface opens a font from the fonts folder and keeps it":
    let a = fileTypeface("Galindo-Regular.ttf", assets)
    check a != nil
    check fileTypeface("Galindo-Regular.ttf", assets) == a
    check fileTypeface("Nonesuch.ttf", assets).isNil
    check fileTypeface("../fonts/Galindo-Regular.ttf", assets).isNil
    check fileTypeface("NotoColorEmoji.ttf", assets) != nil # colour bitmaps

  test "SVG and JSX text past the parse budget is read in place, not dropped":
    setSvgFontAssetsPath(assets)
    defer: setSvgFontAssetsPath("/srv/assets")
    let resolve = svgTypefaceResolver()
    let default = getDefaultTypeface()
    var seen: seq[Typeface]
    for family in ["Galindo", "Peralta", "PT Sans", "Comic Relief", "Liberation Mono",
        "Liberation Sans", "Liberation Serif", "Cormorant Garamond", "FiraGO",
        "Cascadia Mono", "Ubuntu Light", "Ubuntu Medium", "FiraGO Thin"]:
      checkpoint family
      let face = resolve(family, 400, false)
      check face != nil
      check face != default
      check face notin seen
      seen.add face

suite "colour emoji from a bitmap font read in place":
  const text = "Hi 😀 the 🎉 party 👍🏽 ok ❤️ 🇪🇪"

  proc emojiFace(file: bool): Typeface =
    let
      base = if file: openTypefaceFile(fontsDir / "Ubuntu-Regular.ttf") else: parseTtf(readFile(fontsDir / "Ubuntu-Regular.ttf"))
      emoji = if file: openTypefaceFile(fontsDir / "NotoColorEmoji.ttf") else: parseTtf(readFile(fontsDir / "NotoColorEmoji.ttf"))
    base.fallbacks.add emoji
    base

  proc drawn(face: Typeface, size: float32): Image =
    let font = newFont(face)
    font.size = size
    font.paint = parseHtmlColor("#000")
    result = newImage(520, 80)
    result.fill(rgba(255, 255, 255, 255))
    result.fillText(font.typeset(text), translate(vec2(6, 10)))

  test "draws as pixie's whole parse of the same font, within a resampling's difference":
    let previousBudget = colorGlyphCacheBudget
    defer: colorGlyphCacheBudget = previousBudget
    colorGlyphCacheBudget = 64 * 1024
    for size in [18'f32, 32]:
      checkpoint $size
      let
        a = drawn(emojiFace(true), size)
        b = drawn(emojiFace(false), size)
      var
        colored, far = 0
        total = 0.0
      for y in 0 ..< a.height:
        for x in 0 ..< a.width:
          let
            p = a.unsafe[x, y]
            q = b.unsafe[x, y]
            d = max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)), abs(p.b.int - q.b.int))
          if q.r != q.g or q.g != q.b:
            inc colored # the whole parse drew colour here
          total += d.float
          if d > 96:
            inc far
      # Both drew the emoji in colour, and in the same places: the copy kept
      # at its size lands on a whole pixel, the whole parse's at a fraction.
      check colored > 200
      check total / (a.width * a.height).float < 6
      check far < colored div 4

  test "kept at the size drawn, within the budget, and read again only when it went":
    let previousBudget = colorGlyphCacheBudget
    defer: colorGlyphCacheBudget = previousBudget
    clearColorGlyphCache()
    colorGlyphCacheBudget = 16 * 1024
    let face = emojiFace(true)
    let font = newFont(face)
    font.size = 24
    let image = newImage(400, 60)
    colorGlyphDecodes = 0
    image.fillText(font.typeset("😀🎉👍"))
    check colorGlyphDecodes == 3
    image.fillText(font.typeset("😀🎉👍"))
    check colorGlyphDecodes == 3 # all three kept
    check colorGlyphCacheBytes() <= 16 * 1024
    # More than fit: the oldest go, the budget holds.
    image.fillText(font.typeset("🍎🍌🍇🍉🍓🍒🍑🥝🍍🥥🥑🍆"))
    check colorGlyphCacheBytes() <= 16 * 1024
    clearColorGlyphCache()
    check colorGlyphCacheBytes() == 0

  test "a render that needs more than the budget keeps what fits, as the glyph cache does":
    let previousBudget = colorGlyphCacheBudget
    defer: colorGlyphCacheBudget = previousBudget
    clearColorGlyphCache()
    colorGlyphCacheBudget = 40 * 1024 # about four of these at 36 px
    let font = newFont(emojiFace(true))
    font.size = 36
    let image = newImage(800, 60)
    const line = "😀🎉👍❤🍎🚀🐱🌈⚡🍕🎵☀"
    newGlyphCachePass()
    colorGlyphDecodes = 0
    image.fillText(font.typeset(line))
    check colorGlyphDecodes == 12
    newGlyphCachePass()
    colorGlyphDecodes = 0
    image.fillText(font.typeset(line))
    # Plain LRU put out each emoji just before it was drawn again: 12 of 12.
    check colorGlyphDecodes <= 9
    check colorGlyphCacheBytes() <= 40 * 1024

  test "an emoji's PNG and its decode are let go once it is drawn":
    let previousBudget = colorGlyphCacheBudget
    defer: colorGlyphCacheBudget = previousBudget
    clearColorGlyphCache()
    clearFontPages()
    colorGlyphCacheBudget = 0 # nothing kept
    let font = newFont(emojiFace(true))
    font.size = 40
    let image = newImage(400, 80)
    image.fillText(font.typeset("😀")) # the page cache and tables made
    GC_fullCollect()
    let before = getOccupiedMem()
    image.fillText(font.typeset("😀🎉👍🍎🍌🍇"))
    GC_fullCollect()
    # Six 136x128 PNGs decoded (70 KB each) and scaled: none of it stays.
    check getOccupiedMem() - before < 4096

## A TrueType file read where it lies (fontformats/filefont.nim): its
## character map, advances, boxes, outlines and kerning are the whole parse's
## (opentype.nim), what it cannot read in place it refuses, and it holds a
## page cache and nothing of the glyphs. FrameOS's own test
## (src/frameos/utils/tests/test_file_font.nim) runs every font it ships.

import pixie, pixie/paths, pixie/fontformats/filefont, std/unicode

const fonts = [
  "tests/fonts/Roboto-Regular_1.ttf",
  "tests/fonts/Ubuntu-Regular_1.ttf",
  "tests/fonts/PinyonScript.ttf",
  "tests/fonts/NotoSans-Regular_4.ttf",
  "tests/fonts/IBMPlexSans-Regular_2.ttf",
  "tests/fonts/Pacifico-Regular_4.ttf",
  "tests/fonts/Aclonica-Regular_1.ttf"
]

block:
  for path in fonts:
    let
      file = openTypefaceFile(path)
      whole = readTypeface(path)
    doAssert file.scale == whole.scale, path
    doAssert file.ascent == whole.ascent, path
    doAssert file.descent == whole.descent, path
    doAssert file.lineGap == whole.lineGap, path
    doAssert file.capHeight == whole.capHeight, path
    for r in 0x20 .. 0x52F:
      let rune = Rune(r)
      doAssert file.hasGlyph(rune) == whole.hasGlyph(rune), path & " " & $r
      doAssert file.getAdvance(rune) == whole.getAdvance(rune), path & " " & $r
      if whole.hasGlyph(rune):
        doAssert sameCommands(file.getGlyphPath(rune), whole.getGlyphPath(rune)),
          path & " " & $r
        let
          a = file.glyphPath(rune, 30)
          b = whole.glyphPath(rune, 30)
        doAssert a.isNil == b.isNil
        if not a.isNil:
          doAssert a.localBounds() == b.localBounds()
    for l in 0x20 .. 0x17F:
      for r in 0x41 .. 0x7A:
        doAssert file.getKerningAdjustment(Rune(l), Rune(r)) ==
          whole.getKerningAdjustment(Rune(l), Rune(r)), path & " " & $l & " " & $r
  echo "filefont: reads as the whole parse"

block:
  # What is not a TrueType file of glyf outlines is refused, never misread.
  for path in ["tests/fonts/NotoEmoji.otf", "tests/fonts/Inter-Bold.ttf", "tests/fonts/PTSans.ttc",
      "tests/fonts/EmojiCbdt.ttf", "tests/fonts/Ubuntu.svg"]:
    var refused = false
    try:
      discard openTypefaceFile(path)
    except PixieError:
      refused = true
    doAssert refused, path
  echo "filefont: refuses what it cannot read in place"

block:
  # Text sets and draws exactly as the whole parse, through the glyph cache.
  glyphCacheBudget = 64 * 1024
  defer: glyphCacheBudget = 0
  const text = "Wave AVAST, To. Typeset — Ünïcödé Ω Ж fi 1234567890"
  let
    a = newFont(openTypefaceFile("tests/fonts/Roboto-Regular_1.ttf"))
    b = newFont(readTypeface("tests/fonts/Roboto-Regular_1.ttf"))
  a.size = 23
  b.size = 23
  let
    ta = a.typeset(text, bounds = vec2(300, 200))
    tb = b.typeset(text, bounds = vec2(300, 200))
  doAssert ta.positions == tb.positions
  let ia = newImage(320, 200)
  let ib = newImage(320, 200)
  ia.fillText(ta, translate(vec2(5.25, 4)))
  ib.fillText(tb, translate(vec2(5.25, 4)))
  proc differing(a, b: Image): int =
    for y in 0 ..< a.height:
      for x in 0 ..< a.width:
        if a.unsafe[x, y] != b.unsafe[x, y]:
          inc result
  doAssert differing(ia, ib) == 0
  # The page cache and its tables are all a file font holds, and a small one
  # still sets text (it reads pages again).
  doAssert fontPagesHeldBytes() > 0 and fontPagesHeldBytes() < 24 * 1024
  clearFontPages()
  fileFontPages = 2
  let ic = newImage(320, 200)
  clearGlyphCache()
  ic.fillText(a.typeset(text, bounds = vec2(300, 200)), translate(vec2(5.25, 4)))
  doAssert differing(ic, ia) == 0
  releaseFontFiles()
  echo "filefont: sets and draws as the whole parse"

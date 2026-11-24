## fontformats/indexedfont.nim against an indexed font (.fosf) that is not
## what it says. The one such font a frame reads is compiled into it, so this
## is about the reader's own bounds, not about a file from outside: it reads
## through a bare pointer with no check of Nim's, and the font here sits in
## an allocation of exactly its size (see fuzzing.nim).
##
## Each round breaks the built-in face's file and asks the reader what a
## typesetter and the glyph cache ask.

import bumpy, fuzzing, pixie/common, pixie/fontformats/indexedfont, std/[os, random, strformat]

const fontPath = "../assets/compiled/fonts/Ubuntu-Regular.fosf"

if not fileExists(fontPath):
  # pixie checked out by itself: the font is FrameOS's, one directory up.
  echo "no ", fontPath, ": nothing to fuzz"
  quit(0)

let original = readFile(fontPath)
var rng = fuzzRand()

proc ask(rng: var Rand, font: IndexedFont) =
  var glyphs: seq[int]
  for r in 0x20 .. 0x7E:
    glyphs.add font.glyphIdOf(r.int32)
  for _ in 0 ..< 64:
    let rune = rng.rand(0 .. 0x2FFF).int32
    glyphs.add font.glyphIdOf(rune)
    discard font.hasGlyph(rune)
    outline:
      discard font.getGlyphPath(rune)
  for _ in 0 ..< 48:
    glyphs.add rng.rand(-2 .. font.numGlyphs + 2)
  for glyph in glyphs:
    discard font.advance(glyph)
    var box: Rect
    discard font.glyphBox(glyph, box)
    if glyph >= 0 and glyph <= uint16.high.int:
      outline:
        discard font.parseGlyfGlyph(glyph.uint16, 0)
  for _ in 0 ..< 96:
    discard font.kerning(glyphs[rng.rand(glyphs.high)], glyphs[rng.rand(glyphs.high)])

for i in 0 ..< fuzzIterations(100_000_000):
  fuzzRound()
  var data = original
  let how = mutate(rng, data)
  # The header states the file's length, and the reader stops at a wrong one:
  # most rounds put it right again, so a break is read past that check.
  let mended = data.len >= 64 and rng.rand(7) != 0
  if mended:
    for b in 0 ..< 4:
      data[60 + b] = ((data.len shr (8 * b)) and 0xFF).char
  echo &"{i}{how} mended={mended}"

  if rng.rand(7) == 0:
    clearIndexedFontBlocks()

  var bytes = heapBytes(data)
  var font: IndexedFont
  try:
    font = parseIndexedFont(bytes.data, bytes.len)
  except PixieError:
    bytes.free()
    continue
  ask(rng, font)
  # Its blocks go with it: the cache names a font by an id, never by where
  # its bytes were.
  clearIndexedFontBlocks()
  bytes.free()

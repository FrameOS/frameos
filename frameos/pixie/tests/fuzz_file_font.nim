## fontformats/filefont.nim against a TrueType file that is not what it says:
## the fonts on a frame's card, which arrive from wherever the card or a
## scene's download took them.
##
## Each round breaks one of the fonts the reader takes, writes it out, and
## asks the reader everything a typesetter and the glyph cache ask: a rune's
## glyph, its advance, box and outline, a pair's kerning, a colour glyph's
## PNG. Whatever comes back, or a PixieError, is fine; a read outside the
## page cache, an index out of range or a round that never ends is not. The
## file is told to be the size it is, a size it is not, or it changes under
## the reader; the page cache runs at one page as well as at sixteen, so a
## reader that keeps a page across another read is caught.

import bumpy, fuzzing, pixie/common, pixie/fontformats/filefont, pixie/fontformats/opentype,
  std/[os, random, strformat]

const fonts = [
  "tests/fonts/Roboto-Regular_1.ttf",
  "tests/fonts/Ubuntu-Regular_1.ttf",
  "tests/fonts/PinyonScript.ttf",
  "tests/fonts/NotoSans-Regular_4.ttf",
  "tests/fonts/IBMPlexSans-Regular_2.ttf",
  "tests/fonts/Pacifico-Regular_4.ttf",
  "tests/fonts/Aclonica-Regular_1.ttf",
  "tests/fonts/EmojiCbdt.ttf"
]

var rng = fuzzRand()

let path = getTempDir() / &"pixie-fuzz-file-font-{getCurrentProcessId()}.ttf"

proc u16(data: string, at: int): int =
  (data[at].int shl 8) or data[at + 1].int

proc u32(data: string, at: int): int =
  (data.u16(at) shl 16) or data.u16(at + 2)

proc tables(data: string): seq[tuple[at, len: int]] =
  ## Where the file's tables are, by its own directory.
  for i in 0 ..< data.u16(4):
    let record = 12 + i * 16
    if record + 16 > data.len:
      break
    let
      at = data.u32(record + 8)
      len = data.u32(record + 12)
    if at < data.len and len > 0:
      result.add (at, min(len, data.len - at))

proc breakFont(rng: var Rand, data: var string): string =
  ## A byte or a few set to anything, where a font keeps what the reader
  ## trusts: the table directory, the start of a table (its header and
  ## counts), anywhere in a table. Then, sometimes, the file cut short.
  let spots = tables(data)
  for _ in 0 ..< rng.rand(1 .. 4):
    let pos =
      case rng.rand(3)
      of 0: rng.rand(0 ..< min(data.len, 12 + 16 * 24))
      of 1:
        let t = spots[rng.rand(spots.high)]
        t.at + rng.rand(0 ..< min(t.len, 64))
      of 2:
        let t = spots[rng.rand(spots.high)]
        t.at + rng.rand(0 ..< t.len)
      else: rng.rand(0 ..< data.len)
    let value = rng.rand(255)
    data[pos] = value.char
    result.add &" {pos}={value}"
  if rng.rand(7) == 0:
    let keep = rng.rand(0 ..< data.len)
    data.setLen(keep)
    result.add &" cut={keep}"

proc ask(rng: var Rand, font: FileFont) =
  ## What a typesetter and the glyph cache ask of a font.
  var runes: seq[int32]
  for r in 0x20 .. 0x7E:
    runes.add r.int32
  for _ in 0 ..< 48:
    runes.add rng.rand(0 .. 0x1FAFF).int32
  for _ in 0 ..< 16:
    runes.add rng.rand(0xA0 .. 0x52F).int32
  var glyphs: seq[int]
  for rune in runes:
    let glyph = font.glyphIdOf(rune)
    glyphs.add glyph
    discard font.hasGlyph(rune)
    discard font.hasColorGlyph(rune)
    outline:
      discard font.getGlyphPath(rune)
    for size in [12'f32, 109]:
      var bitmap: BitmapGlyph
      try:
        discard font.bitmapGlyph(rune, size, bitmap)
      except PixieError:
        discard
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
  let name = fonts[rng.rand(fonts.high)]
  var data = readFile(name)
  let how = breakFont(rng, data)

  # As a host does between renders: the file is closed. And the cache is
  # sometimes made again, small, so one read pushes out the page before it.
  releaseFontFiles()
  if rng.rand(3) == 0:
    fileFontPages = [0, 1, 1, 2, 3][rng.rand(4)]
    fileFontMemos = [0, 0, 16, 256][rng.rand(3)]
    clearFontPages()
  writeFile(path, data)

  # The size the reader is told: the file's, or not.
  let said =
    case rng.rand(9)
    of 0: data.len + rng.rand(1 .. 70_000)
    of 1: rng.rand(0 .. data.len)
    else: data.len
  echo &"{i} {name}{how} said={said} pages={fileFontPages} memos={fileFontMemos}"

  var font: FileFont
  try:
    font = openFileFont(path, said)
  except PixieError:
    continue
  ask(rng, font)

  # And the file changes under an open font: shorter, then gone.
  if rng.rand(7) == 0:
    releaseFontFiles()
    writeFile(path, data[0 ..< rng.rand(0 .. data.len)])
    ask(rng, font)
  if rng.rand(15) == 0:
    releaseFontFiles()
    removeFile(path)
    ask(rng, font)

releaseFontFiles()
removeFile(path)

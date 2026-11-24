import pixie/common, pixie/fontformats/indexedfont, std/os

# The indexed font's kerning section, read in place with the checks off in a
# release: a head that places a table outside the file is refused when the
# font is read, and an index read out of a table that names something outside
# the table it points into kerns by nothing. Found by fuzz_indexed_font
# (2026-11-24, seed 363256417) under AddressSanitizer: 1020 bytes past the
# file's end.

const fontPath = "../assets/compiled/fonts/Ubuntu-Regular.fosf"

if not fileExists(fontPath):
  echo "no ", fontPath, ": skipped (pixie checked out by itself)"
  quit(0)

let original = readFile(fontPath)

proc u16(data: string, at: int): int =
  data[at].int or (data[at + 1].int shl 8)

proc u32(data: string, at: int): int =
  data.u16(at) or (data.u16(at + 2) shl 16)

proc put16(data: var string, at, v: int) =
  data[at] = char(v and 0xff)
  data[at + 1] = char((v shr 8) and 0xff)

proc put32(data: var string, at, v: int) =
  data.put16(at, v and 0xffff)
  data.put16(at + 2, (v shr 16) and 0xffff)

proc refused(data: string): bool =
  try:
    discard parseIndexedFont(data)
  except PixieError:
    return true

let kernAt = original.u32(52)

block:
  # The font as built reads, and kerns some pair of letters.
  let font = parseIndexedFont(original)
  var kerned = 0
  for left in 0x41 .. 0x5A:
    for right in 0x61 .. 0x7A:
      if font.kerning(font.glyphIdOf(left.int32), font.glyphIdOf(right.int32)) != 0:
        inc kerned
  doAssert kerned > 0

block:
  # Each table placed so that it runs past the file's end.
  for field in [8, 12, 16, 20, 24]:
    var data = original
    data.put32(kernAt + field, data.len - 2)
    doAssert refused(data), $field
  # Counts that run the left glyphs' and rows' tables past the end.
  for field in [0, 2, 4]:
    var data = original
    data.put16(kernAt + field, 0xffff)
    doAssert refused(data), $field

block:
  # Every left glyph's first pair, and every row's first entry, past the end
  # of its table: the font reads, and nothing kerns by what is not there.
  var data = original
  let
    lefts = data.u16(kernAt)
    leftsAt = data.u32(kernAt + 8)
    rows = data.u16(kernAt + 4)
    rowsAt = data.u32(kernAt + 20)
  for i in 0 ..< lefts:
    data.put16(leftsAt + i * 4 + 2, 0xfff0)
  for i in 0 ..< rows:
    data.put16(rowsAt + i * 2, 0xfff0)
  let font = parseIndexedFont(data)
  for left in 0 ..< font.numGlyphs:
    for right in [0, 1, left, font.numGlyphs - 1]:
      doAssert font.kerning(left, right) == 0

block:
  # A run naming a row the rows table does not have.
  var data = original
  let runsAt = data.u32(kernAt + 16)
  for i in 0 ..< data.u16(kernAt + 2):
    data[runsAt + i * 4 + 2] = '\xff'
  let font = parseIndexedFont(data)
  for left in 0 ..< font.numGlyphs:
    discard font.kerning(left, 0)

echo "indexed font kerning bounds: ok"

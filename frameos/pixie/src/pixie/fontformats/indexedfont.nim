## A font read where it lies: FrameOS's indexed font ("FOSF", made from a
## TrueType font by frameos/tools/generate_indexed_font.py, which documents
## the layout). The typesetter's tables (the character map, the advances, the
## glyph boxes, the kerning) are read in place, a binary search over the
## font's own bytes, which can be the program image's read-only data: nothing
## of them is copied. The outlines are TrueType glyf records in blocks of
## about 2 KB: deflated, except the blocks of printable ASCII, which are read
## in place and are the preset dictionary the others were deflated against. A
## glyph's outline in a deflated block inflates it, and the last two blocks
## inflated are kept per thread (`{.threadvar.}`: values no other thread
## touches). Advances, kerning and outlines are the TrueType font's, as
## `opentype.nim` reads them.

import bumpy, vmath, ../common, ../inflatestream, ../paths, opentype

type
  IndexedFont* = ref object
    data: ptr UncheckedArray[uint8]
    len: int
    keep: string # the bytes, when they were handed over as a string
    id: uint32 # names the font in the block cache
    unit: int # font units a box unit is
    unitsPerEm*: int
    ascender*, descender*, lineGap*, capHeight*: int
    underlinePosition*, underlineThickness*: int
    strikeoutPosition*, strikeoutSize*: int
    numGlyphs*: int
    numRuns, numBlocks, dictLen, numValues: int
    cmapAt, glyphsAt, blocksAt, blockDataAt, kernAt, valuesAt: int

const
  HeaderBytes = 64
  GlyphBytes = 7
  KernHeadBytes = 28
  BlockCacheSlots = 2

var
  indexedFontIds: int
  blockFont {.threadvar.}: array[BlockCacheSlots, uint32]
  blockIndex {.threadvar.}: array[BlockCacheSlots, int]
  blockData {.threadvar.}: array[BlockCacheSlots, string]
  blockNext {.threadvar.}: int
  indexedFontInflates* {.threadvar.}: int ## blocks this thread inflated

when defined(release):
  {.push checks: off.}

template fail(msg: string) =
  raise newException(PixieError, "Invalid indexed font: " & msg)

proc u8(font: IndexedFont, at: int): int {.inline.} =
  font.data[at].int

proc u16(font: IndexedFont, at: int): int {.inline.} =
  font.data[at].int or (font.data[at + 1].int shl 8)

proc i16(font: IndexedFont, at: int): int {.inline.} =
  cast[int16](font.u16(at).uint16).int

proc i8(font: IndexedFont, at: int): int {.inline.} =
  cast[int8](font.data[at]).int

proc u32(font: IndexedFont, at: int): int {.inline.} =
  font.u16(at) or (font.u16(at + 2) shl 16)

proc readHeader(font: IndexedFont) =
  if font.len < HeaderBytes or font.data[0] != uint8('F') or font.data[1] != uint8('O') or
      font.data[2] != uint8('S') or font.data[3] != uint8('F'):
    fail("no FOSF header")
  if font.u16(4) != 3:
    fail("version " & $font.u16(4))
  font.unit = font.u16(6)
  font.unitsPerEm = font.u16(8)
  font.ascender = font.i16(10)
  font.descender = font.i16(12)
  font.lineGap = font.i16(14)
  font.capHeight = font.i16(16)
  font.underlinePosition = font.i16(18)
  font.underlineThickness = font.i16(20)
  font.strikeoutPosition = font.i16(22)
  font.strikeoutSize = font.i16(24)
  font.numGlyphs = font.u16(26)
  font.numRuns = font.u16(28)
  font.numBlocks = font.u16(30)
  font.dictLen = font.u16(32)
  font.numValues = font.u16(34)
  font.cmapAt = font.u32(36)
  font.glyphsAt = font.u32(40)
  font.blocksAt = font.u32(44)
  font.blockDataAt = font.u32(48)
  font.kernAt = font.u32(52)
  font.valuesAt = font.u32(56)
  if font.u32(60) != font.len or font.unitsPerEm == 0 or font.numBlocks == 0 or
      font.cmapAt + font.numRuns * 8 > font.len or
      font.glyphsAt + font.numGlyphs * GlyphBytes > font.len or
      font.blocksAt + (font.numBlocks + 1) * 8 > font.len or
      font.blockDataAt + font.dictLen > font.len or
      font.kernAt + KernHeadBytes > font.len or
      font.valuesAt + font.numValues * 2 > font.len:
    fail("sections out of bounds")
  font.id = uint32(atomicInc(indexedFontIds))

proc parseIndexedFont*(data: ptr UncheckedArray[uint8], len: int): IndexedFont {.raises: [PixieError].} =
  ## The font in `data`, read in place: the bytes must stay where they are
  ## for as long as the font is used (the program image's read-only data).
  result = IndexedFont(data: data, len: len)
  result.readHeader()

proc parseIndexedFont*(data: sink string): IndexedFont {.raises: [PixieError].} =
  ## The font in `data`, which it keeps. A string literal (a font compiled
  ## in) is kept where it lies, not copied.
  let len = data.len
  result = IndexedFont(keep: data, len: len)
  if result.len > 0:
    result.data = cast[ptr UncheckedArray[uint8]](result.keep[0].addr)
  result.readHeader()

proc glyphIdOf*(font: IndexedFont, rune: int32): int {.raises: [].} =
  ## The glyph `rune` maps to, -1 for none.
  var
    lo = 0
    hi = font.numRuns - 1
  let r = rune.int
  while lo <= hi:
    let
      mid = (lo + hi) div 2
      at = font.cmapAt + mid * 8
      first = font.u32(at)
    if r < first:
      hi = mid - 1
    elif r >= first + font.u16(at + 4):
      lo = mid + 1
    else:
      return font.u16(at + 6) + r - first
  -1

proc hasGlyph*(font: IndexedFont, rune: int32): bool {.raises: [].} =
  font.glyphIdOf(rune) >= 0

proc advance*(font: IndexedFont, glyph: int): int {.raises: [].} =
  if glyph < 0 or glyph >= font.numGlyphs:
    return 0
  font.u16(font.glyphsAt + glyph * GlyphBytes) and 0xFFF

proc offsetInBlock(font: IndexedFont, glyph: int): int =
  ## Where the glyph's record starts in its block: the high 12 bits of the
  ## glyph's first three bytes (the advance is the low 12).
  let at = font.glyphsAt + glyph * GlyphBytes
  (font.u16(at) shr 12) or (font.u8(at + 2) shl 4)

proc glyphBox*(font: IndexedFont, glyph: int, box: var Rect): bool {.raises: [].} =
  ## The glyph's box, rounded outwards, in font units, y down like
  ## `glyphPath`'s outline; false where the font gives none (outline it).
  ## True with an empty box for a glyph that draws nothing.
  box = rect(0, 0, 0, 0)
  if glyph < 0 or glyph >= font.numGlyphs:
    return true
  let at = font.glyphsAt + glyph * GlyphBytes
  if font.i8(at + 3) == -128:
    return false
  let
    u = font.unit.float32
    xMin = font.i8(at + 3).float32 * u
    yMin = font.i8(at + 4).float32 * u
    xMax = font.i8(at + 5).float32 * u
    yMax = font.i8(at + 6).float32 * u
  if xMax > xMin and yMax > yMin:
    box = rect(xMin, -yMax, xMax - xMin, yMax - yMin)
  true

proc blockOf(font: IndexedFont, glyph: int): int =
  var
    lo = 0
    hi = font.numBlocks - 1
  while lo < hi:
    let mid = (lo + hi + 1) div 2
    if font.u16(font.blocksAt + mid * 8) <= glyph:
      lo = mid
    else:
      hi = mid - 1
  lo

proc inflatedBlock(font: IndexedFont, b: int): int =
  ## The cache slot holding block `b` inflated, inflating it there first.
  for slot in 0 ..< BlockCacheSlots:
    if blockFont[slot] == font.id and blockIndex[slot] == b:
      return slot
  let
    at = font.blocksAt + b * 8
    rawLen = font.u16(at + 2)
    start = font.blockDataAt + font.u16(at + 6)
    stop = start + font.u16(at + 4)
  if stop > font.len:
    fail("block out of bounds")
  result = blockNext
  blockNext = (blockNext + 1) mod BlockCacheSlots
  inc indexedFontInflates
  blockFont[result] = 0
  var inflated: string
  try:
    # Its length is known, so the string is made that size and the block is
    # inflated in a buffer of its own size, not the stream's 64 KB window;
    # its preset dictionary is read where it lies.
    inflated = uncompressDeflate(font.data[start].addr, stop - start, rawLen,
      font.data[font.blockDataAt].addr, font.dictLen)
  except PixieError as e:
    raise newException(PixieError, "Invalid indexed font block: " & e.msg, e)
  if inflated.len != rawLen:
    fail("block length")
  blockData[result] = move inflated
  blockFont[result] = font.id
  blockIndex[result] = b

proc glyfRecord(font: IndexedFont, glyph: int): string =
  ## The glyph's glyf record, a copy: a composite reads its components, which
  ## can take another block into the cache over this one.
  if glyph < 0 or glyph >= font.numGlyphs:
    fail("glyph " & $glyph)
  let
    b = font.blockOf(glyph)
    at = font.blocksAt + b * 8
    rawLen = font.u16(at + 2)
    stored = font.u16(at + 4)
    nextFirst = font.u16(at + 8)
    start = font.offsetInBlock(glyph)
    stop =
      if glyph + 1 < nextFirst: font.offsetInBlock(glyph + 1)
      else: rawLen
  if stop <= start:
    return
  if stop > rawLen:
    fail("glyph out of its block")
  if stored == rawLen:
    # Stored as it is: read in place.
    let src = font.blockDataAt + font.u16(at + 6) + start
    if src + (stop - start) > font.len:
      fail("block out of bounds")
    result = newString(stop - start)
    copyMem(result[0].addr, font.data[src].addr, stop - start)
    return
  let slot = font.inflatedBlock(b)
  result = blockData[slot][start ..< stop]

proc parseGlyfGlyph*(font: IndexedFont, glyphId: uint16, recursionDepth: int): Path {.
    raises: [PixieError], gcsafe.} =
  if recursionDepth > 64:
    fail("composite glyph recursion")
  let record = font.glyfRecord(glyphId.int)
  if record.len == 0:
    return newPath()
  if record.len < 2:
    fail("glyph record")
  # The contour count, then the record past its box (which the file leaves
  # out: the glyph table has the box).
  let numberOfContours = cast[int16]((record[0].uint16 shl 8) or record[1].uint16).int
  if numberOfContours < 0:
    font.parseCompositeGlyph(record, 2, recursionDepth)
  else:
    parseGlyphPath(record, 2, numberOfContours)

proc getGlyphPath*(font: IndexedFont, rune: int32): Path {.raises: [PixieError], gcsafe.} =
  ## The rune's outline in font units, y down (as opentype's): read and
  ## inflated now, the caller's to keep. The `.notdef` glyph for a rune the
  ## font does not map.
  result = font.parseGlyfGlyph(max(font.glyphIdOf(rune), 0).uint16, 0)
  result.transform(scale(vec2(1, -1)))

proc entryValue(font: IndexedFont, at, size, first, stop, key: int): int =
  ## In the entries `first ..< stop` at `at`, `size` bytes each, sorted by
  ## their key (a u16 when `size` is 3, a u8 when 2) and ending in a u8
  ## value index, the value index of `key`; -1 for none.
  var
    lo = first
    hi = stop - 1
  while lo <= hi:
    let
      mid = (lo + hi) div 2
      e = at + mid * size
      k = if size == 3: font.u16(e) else: font.u8(e)
    if key < k: hi = mid - 1
    elif key > k: lo = mid + 1
    else: return font.u8(e + size - 1)
  -1

proc runOf(font: IndexedFont, glyph: int): int =
  ## Where the run of glyphs holding `glyph` is: u16 first glyph, u8 row,
  ## u8 column.
  let runsAt = font.u32(font.kernAt + 16)
  var
    lo = 0
    hi = font.u16(font.kernAt + 2) - 1
  while lo < hi:
    let mid = (lo + hi + 1) div 2
    if font.u16(runsAt + mid * 4) <= glyph: lo = mid
    else: hi = mid - 1
  runsAt + lo * 4

proc kerning*(font: IndexedFont, left, right: int): int {.raises: [].} =
  ## The x advance between two glyphs, in font units: the first subtable, in
  ## lookup order, that covers `left` and has a nonzero entry for the pair
  ## (opentype's `getKerningAdjustment`). The file holds the glyph pairs, then
  ## the class subtables merged into one table: the left glyph's row, the
  ## right glyph's column in it.
  if left < 0 or right < 0 or left >= font.numGlyphs or right >= font.numGlyphs:
    return 0
  let
    k = font.kernAt
    leftsAt = font.u32(k + 8)
  var
    v = -1
    lo = 0
    hi = font.u16(k) - 1
  # Glyph pairs: the left glyph's list, then the right glyph in it.
  while lo <= hi:
    let
      mid = (lo + hi) div 2
      g = font.u16(leftsAt + mid * 4)
    if left < g: hi = mid - 1
    elif left > g: lo = mid + 1
    else:
      v = font.entryValue(font.u32(k + 12), 3, font.u16(leftsAt + mid * 4 + 2),
        font.u16(leftsAt + mid * 4 + 6), right)
      break
  if v < 0:
    # Class pairs: the left glyph's row, the right glyph's column in it.
    let row = font.u32(k + 20) + font.u8(font.runOf(left) + 2) * 2
    v = font.entryValue(font.u32(k + 24), 2, font.u16(row), font.u16(row + 2),
      font.u8(font.runOf(right) + 3))
  if v >= 0 and v < font.numValues:
    return font.i16(font.valuesAt + v * 2)
  0

proc clearIndexedFontBlocks*() {.raises: [].} =
  ## Lets go of this thread's inflated blocks.
  for slot in 0 ..< BlockCacheSlots:
    blockFont[slot] = 0
    blockData[slot] = ""

when defined(release):
  {.pop.}

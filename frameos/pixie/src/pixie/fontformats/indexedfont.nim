## A font read where it lies: FrameOS's indexed font ("FOSF", made from a
## TrueType font by frameos/tools/generate_indexed_font.py, which documents
## the layout). The typesetter's tables (the character map, the advances, the
## glyph boxes, the kerning) are read in place, a binary search over the
## font's own bytes, which can be the program image's read-only data: nothing
## of them is copied. The outlines are TrueType glyf records in blocks of
## about 2 KB: deflated, except the blocks of printable ASCII, which are read
## in place. A glyph's outline in a deflated block inflates it, and the last
## two blocks inflated are kept per thread (`{.threadvar.}`: values no other
## thread touches). Advances, kerning and outlines are the TrueType font's,
## as `opentype.nim` reads them.

import bumpy, vmath, zippy, ../common, ../paths, opentype

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
    numRuns, numBlocks, numTables, numValues: int
    cmapAt, glyphsAt, blocksAt, blockDataAt, kernAt, valuesAt: int

const
  HeaderBytes = 64
  KernTableBytes = 24
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
  if font.u16(4) != 1:
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
  font.numTables = font.u16(32)
  font.numValues = font.u16(34)
  font.cmapAt = font.u32(36)
  font.glyphsAt = font.u32(40)
  font.blocksAt = font.u32(44)
  font.blockDataAt = font.u32(48)
  font.kernAt = font.u32(52)
  font.valuesAt = font.u32(56)
  if font.u32(60) != font.len or font.unitsPerEm == 0 or font.numBlocks == 0 or
      font.cmapAt + font.numRuns * 8 > font.len or
      font.glyphsAt + font.numGlyphs * 8 > font.len or
      font.blocksAt + (font.numBlocks + 1) * 8 > font.len or
      font.kernAt + font.numTables * KernTableBytes > font.len or
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
  font.u16(font.glyphsAt + glyph * 8)

proc glyphBox*(font: IndexedFont, glyph: int, box: var Rect): bool {.raises: [].} =
  ## The glyph's box, rounded outwards, in font units, y down like
  ## `glyphPath`'s outline; false where the font gives none (outline it).
  ## True with an empty box for a glyph that draws nothing.
  box = rect(0, 0, 0, 0)
  if glyph < 0 or glyph >= font.numGlyphs:
    return true
  let at = font.glyphsAt + glyph * 8
  if font.i8(at + 4) == -128:
    return false
  let
    u = font.unit.float32
    xMin = font.i8(at + 4).float32 * u
    yMin = font.i8(at + 5).float32 * u
    xMax = font.i8(at + 6).float32 * u
    yMax = font.i8(at + 7).float32 * u
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
    start = font.blockDataAt + font.u32(at + 4)
    stop = font.blockDataAt + font.u32(at + 12)
  if stop < start or stop > font.len:
    fail("block out of bounds")
  result = blockNext
  blockNext = (blockNext + 1) mod BlockCacheSlots
  inc indexedFontInflates
  blockFont[result] = 0
  var inflated: string
  try:
    inflated = uncompress(font.data[start].addr, stop - start, dfDeflate)
  except ZippyError as e:
    raise newException(PixieError, "Invalid indexed font block: " & e.msg, e)
  if inflated.len != rawLen:
    fail("block length")
  # Kept at its length: the inflate's own string grew by doubling.
  blockData[result] = newString(rawLen)
  if rawLen > 0:
    copyMem(blockData[result][0].addr, inflated[0].addr, rawLen)
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
    stored = font.u32(at + 12) - font.u32(at + 4)
    nextFirst = font.u16(at + 8)
    start = font.u16(font.glyphsAt + glyph * 8 + 2)
    stop =
      if glyph + 1 < nextFirst: font.u16(font.glyphsAt + (glyph + 1) * 8 + 2)
      else: rawLen
  if stop <= start:
    return
  if stop > rawLen:
    fail("glyph out of its block")
  if stored == rawLen:
    # Stored as it is: read in place.
    let src = font.blockDataAt + font.u32(at + 4) + start
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
  if record.len < 10:
    fail("glyph record")
  let numberOfContours = cast[int16]((record[0].uint16 shl 8) or record[1].uint16).int
  if numberOfContours < 0:
    font.parseCompositeGlyph(record, 10, recursionDepth)
  else:
    parseGlyphPath(record, 10, numberOfContours)

proc getGlyphPath*(font: IndexedFont, rune: int32): Path {.raises: [PixieError], gcsafe.} =
  ## The rune's outline in font units, y down (as opentype's): read and
  ## inflated now, the caller's to keep. The `.notdef` glyph for a rune the
  ## font does not map.
  result = font.parseGlyfGlyph(max(font.glyphIdOf(rune), 0).uint16, 0)
  result.transform(scale(vec2(1, -1)))

proc rangeValue(font: IndexedFont, at, count, glyph: int): int =
  ## In `count` (first, last, value) u16 triples at `at`, sorted, the value
  ## of the range holding `glyph`; -1 for none.
  var
    lo = 0
    hi = count - 1
  while lo <= hi:
    let
      mid = (lo + hi) div 2
      r = at + mid * 6
    if glyph < font.u16(r):
      hi = mid - 1
    elif glyph > font.u16(r + 2):
      lo = mid + 1
    else:
      return font.u16(r + 4)
  -1

proc kerning*(font: IndexedFont, left, right: int): int {.raises: [].} =
  ## The x advance between two glyphs, in font units: the first subtable, in
  ## lookup order, that covers `left` and has a nonzero entry for the pair
  ## (opentype's `getKerningAdjustment`).
  if left < 0 or right < 0:
    return 0
  for t in 0 ..< font.numTables:
    let
      h = font.kernAt + t * KernTableBytes
      leftCount = font.u16(h + 2)
      leftAt = font.u32(h + 4)
      secondCount = font.u16(h + 8)
      rowCount = font.u16(h + 10)
      secondAt = font.u32(h + 12)
    var
      first = 0
      count = 0
      entryAt = 0
      key = 0
      entryBytes = 0
    if font.u8(h) == 1:
      # Glyph pairs: the left glyph's list, then the right glyph in it.
      var
        lo = 0
        hi = leftCount - 1
        found = -1
      while lo <= hi:
        let mid = (lo + hi) div 2
        let g = font.u16(leftAt + mid * 8)
        if left < g: hi = mid - 1
        elif left > g: lo = mid + 1
        else:
          found = mid
          break
      if found < 0:
        continue
      first = font.u16(leftAt + found * 8 + 2)
      count = font.u16(leftAt + found * 8 + 4)
      entryAt = secondAt
      entryBytes = 4
      key = right
    else:
      # Class pairs: the left glyph's class row, the right glyph's class in it.
      let class1 = font.rangeValue(leftAt, leftCount, left)
      if class1 < 0 or class1 >= rowCount:
        continue
      let class2 = max(font.rangeValue(secondAt, secondCount, right), 0)
      let row = font.u32(h + 16) + class1 * 4
      first = font.u16(row)
      count = font.u16(row + 2)
      entryAt = font.u32(h + 20)
      entryBytes = 2
      key = class2
    var
      lo = first
      hi = first + count - 1
    while lo <= hi:
      let
        mid = (lo + hi) div 2
        e = entryAt + mid * entryBytes
        k = if entryBytes == 4: font.u16(e) else: font.u8(e)
      if key < k: hi = mid - 1
      elif key > k: lo = mid + 1
      else:
        let v = if entryBytes == 4: font.u16(e + 2) else: font.u8(e + 1)
        if v < font.numValues:
          return font.i16(font.valuesAt + v * 2)
        return 0
  0

proc clearIndexedFontBlocks*() {.raises: [].} =
  ## Lets go of this thread's inflated blocks.
  for slot in 0 ..< BlockCacheSlots:
    blockFont[slot] = 0
    blockData[slot] = ""

when defined(release):
  {.pop.}

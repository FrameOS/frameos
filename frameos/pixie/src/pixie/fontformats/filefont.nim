## A TrueType font read where it lies on a disk: the `.ttf` file as it is, no
## conversion and no index beside it. Opening one reads its table directory
## and a few header fields (a few hundred bytes kept); after that every
## question a typesetter or the glyph cache asks is answered from the file's
## own tables: the character map (format 4 or 12) and the glyph boxes by a
## binary search, the advances and `loca` by an index, a glyph's outline from
## its `glyf` record (read into a string only while it is parsed), and the
## kerning from the GPOS pair positioning subtables in place (coverage and
## class definitions searched, the pair or class record read), in the order
## and by the rule `opentype.nim` builds its tables with, so a face reads,
## sets and draws exactly as pixie's whole parse of the same file.
##
## The bytes come through a page cache on the thread that asks
## (`{.threadvar.}`: values nobody else touches): `fileFontPages` slots of
## 512 bytes, the least recently used page going first, made when a file
## font is first read and never otherwise. A page not in it is read from the
## file, which the thread keeps open between reads (one file at a time:
## `releaseFontFiles` closes it, as a host does after each render).
## Beside the pages, three small tables remember the answers a typesetter
## asks again and again (direct-mapped, sixteen entries a page slot: 14 KB
## with the default 16 pages): a rune's glyph, a glyph's advance and box, a
## pair's kerning. Without them a paragraph set again read 800 pages of
## Ubuntu's GPOS and the fill 160 of FiraGO's glyph headers, a 16-page cache
## thrashing; with them, none. Nothing of a glyph's outline stays in memory
## outside the glyph cache (paths.nim).
##
## A colour bitmap font (CBDT/CBLC, Noto Color Emoji) is read the same way:
## a glyph's PNG is found through the CBLC index subtables where they lie and
## read from CBDT when it is drawn (`bitmapGlyph`), by pixie's rules for the
## strike; it has no outlines.
##
## Not read here: CFF outlines (an .otf of PostScript curves), collections
## (.ttc), WOFF, COLR and sbix colour glyphs. `frameos/tools/font_for_card.py`
## turns the first three into a TrueType file this reads; a variable font
## draws its default instance, as pixie's whole parse does.

import std/monotimes, bumpy, vmath, ../common, ../paths, opentype
from std/times import inNanoseconds

type
  FileFont* = ref object
    path*: string
    fileSize*: int
    id: uint32 ## names the font in the page cache; never reused
    stale*: bool ## the file changed under it (its size): open it again
    unitsPerEm*: int
    ascender*, descender*, lineGap*, capHeight*: int
    underlinePosition*, underlineThickness*: int
    strikeoutPosition*, strikeoutSize*: int
    numGlyphs*: int
    numHMetrics: int
    longLoca: bool
    cmapAt, cmapFormat: int
    hmtxAt, locaAt, glyfAt, glyfEnd: int
    pairTables: seq[uint32]
      ## The GPOS pair positioning subtables kerning reads, in lookup order:
      ## two words each, the subtable's place and the first and last glyph
      ## its coverage holds (a pair whose left glyph is outside is not
      ## looked for there). Eight bytes a subtable, read once at the open:
      ## walking the lookup list for every pair read a page of it a lookup.
    kernAt: int ## the kern table, read only without GPOS (as pixie does)
    cblcAt, cbdtAt: int ## colour bitmap glyphs (CBLC, CBDT); 0 for none

type
  RuneMemo = object
    font: uint32
    rune: int32
    glyph: int32
  GlyphMemo = object
    font: uint32
    glyph: int32
    advance: uint16
    boxKind: uint8 ## 0 not read yet, 1 none, 2 the box below
    colorKind: uint8 ## 0 not read yet, 1 no colour bitmap, 2 one
    box: array[4, int16] ## x min, y min, x max, y max as the glyf header says
  KernMemo = object
    font: uint32
    pair: uint32
    value: int32

const
  PageShift {.intdefine: "fileFontPageShift".} = 10 ## 1 KB pages: on a card the read is the cost, not its size
  FontPageBytes* = 1 shl PageShift
  DefaultPages = 16
  DefaultMemos = 256
  MaxRecordBytes = 64 * 1024 ## a glyf record larger than this is refused
  MaxPngBytes = 512 * 1024 ## and a colour glyph's PNG

var
  fileFontIds: int
  fileFontPages* {.threadvar.}: int
    ## Page slots of the cache on this thread; 0 = 16.
  fileFontMemos* {.threadvar.}: int
    ## Entries of each memo table (a rune's glyph, a glyph's advance and
    ## box; twice that for a pair's kerning), two ways each; 0 = 256.
  fileFontPageReads* {.threadvar.}: int ## pages this thread read from a file
  fileFontReadNs* {.threadvar.}: int64 ## and the time those reads took
  fileFontOpens* {.threadvar.}: int ## files it opened for them
  fileFontClears* {.threadvar.}: int ## times its page cache was let go
  pagesMade {.threadvar.}: int
  pageFont {.threadvar.}: seq[uint32]
  pageIndex {.threadvar.}: seq[int]
  pageUsed {.threadvar.}: seq[uint32]
  pageData {.threadvar.}: string
  pageLast {.threadvar.}: int
  pageTick {.threadvar.}: uint32
  heldFont {.threadvar.}: uint32
  heldFile {.threadvar.}: File
  memoBits {.threadvar.}: int
  runeMemo {.threadvar.}: seq[RuneMemo]
  glyphMemo {.threadvar.}: seq[GlyphMemo]
  kernMemo {.threadvar.}: seq[KernMemo]

when defined(release):
  {.push checks: off.}

template fail(msg: string) =
  raise newException(PixieError, "Invalid TrueType font: " & msg)

proc releaseFontFiles*() {.raises: [].} =
  ## Closes the file this thread keeps open for its file fonts: a host calls
  ## it after a render, so nothing holds a file on the card between renders.
  ## The pages stay; the next miss opens the file again.
  if heldFile != nil:
    try:
      heldFile.close()
    except CatchableError, Defect:
      discard
  heldFile = nil
  heldFont = 0

proc clearFontPages*() {.raises: [].} =
  ## Lets go of this thread's page cache (and its open file).
  if pagesMade > 0:
    inc fileFontClears
  releaseFontFiles()
  pageFont = @[]
  pageIndex = @[]
  pageUsed = @[]
  pageData = ""
  pagesMade = 0
  pageLast = 0
  runeMemo = @[]
  glyphMemo = @[]
  kernMemo = @[]
  memoBits = 0

proc fontPagesHeldBytes*(): int {.raises: [].} =
  ## What this thread's page cache and its tables hold.
  pageData.len + pageFont.len * (sizeof(uint32) * 2 + sizeof(int)) +
    runeMemo.len * sizeof(RuneMemo) + glyphMemo.len * sizeof(GlyphMemo) +
    kernMemo.len * sizeof(KernMemo)

proc memoSlot(font: FileFont, key: uint32, wider = 0): int {.inline.} =
  ## The entry `key` of `font` goes in: sixteen a page slot, a power of two.
  if memoBits == 0:
    let entries = if fileFontMemos > 0: fileFontMemos else: DefaultMemos
    memoBits = 4
    while (1 shl memoBits) < entries and memoBits < 16:
      inc memoBits
    runeMemo = newSeq[RuneMemo](1 shl memoBits)
    glyphMemo = newSeq[GlyphMemo](1 shl memoBits)
    kernMemo = newSeq[KernMemo](2 shl memoBits)
  # The first of a pair: two ways, the one used last first (`memoPair`).
  int(((key + font.id * 0x9E3779B1'u32) * 0x85EBCA6B'u32) shr (32 - memoBits - wider)) and not 1

template memoPair(memo: untyped, slot: int, hit: untyped): int =
  ## Which of the pair at `slot` holds the entry `hit` says (`it` is the
  ## entry), moved to the first way when it was the second; -1 for none.
  var found = -1
  block:
    template it: untyped = memo[slot]
    if hit:
      found = slot
  if found < 0:
    block:
      template it: untyped = memo[slot + 1]
      if hit:
        swap(memo[slot], memo[slot + 1])
        found = slot
  found

template memoPut(memo: untyped, slot: int, entry: untyped) =
  ## A new entry in the first way; what was there goes to the second.
  memo[slot + 1] = memo[slot]
  memo[slot] = entry

proc readPage(font: FileFont, slot, page: int) =
  ## Reads `page` of the file into `slot`; what the file does not have is 0.
  let at = slot shl PageShift
  zeroMem(pageData[at].addr, FontPageBytes)
  pageFont[slot] = font.id
  pageIndex[slot] = page
  let want = min(FontPageBytes, font.fileSize - (page shl PageShift))
  if want <= 0:
    return
  inc fileFontPageReads
  let started = getMonoTime()
  defer: fileFontReadNs += (getMonoTime() - started).inNanoseconds
  try:
    if heldFont != font.id or heldFile == nil:
      releaseFontFiles()
      inc fileFontOpens
      if not open(heldFile, font.path, fmRead, bufSize = 0):
        heldFile = nil
        font.stale = true
        return
      heldFont = font.id
      if heldFile.getFileSize() != font.fileSize:
        font.stale = true
    if font.stale:
      return # another file now: its bytes would be read through this one's tables
    heldFile.setFilePos(page shl PageShift)
    if heldFile.readBuffer(pageData[at].addr, want) != want:
      font.stale = true
  except CatchableError:
    font.stale = true
    releaseFontFiles()

proc slotOf(font: FileFont, page: int): int =
  ## The cache slot holding `page` of the font, read into the least recently
  ## used one first if it is not there.
  if pagesMade > 0 and pageFont[pageLast] == font.id and pageIndex[pageLast] == page:
    return pageLast
  let pages = if fileFontPages > 0: fileFontPages else: DefaultPages
  if pagesMade != pages:
    pageFont = newSeq[uint32](pages)
    pageIndex = newSeq[int](pages)
    pageUsed = newSeq[uint32](pages)
    pageData = newString(pages * FontPageBytes)
    pagesMade = pages
  inc pageTick
  var oldest = 0
  for slot in 0 ..< pagesMade:
    if pageFont[slot] == font.id and pageIndex[slot] == page:
      pageUsed[slot] = pageTick
      pageLast = slot
      return slot
    if pageUsed[slot] < pageUsed[oldest]:
      oldest = slot
  font.readPage(oldest, page)
  pageUsed[oldest] = pageTick
  pageLast = oldest
  oldest

proc u8(font: FileFont, at: int): int =
  if at < 0 or at >= font.fileSize:
    return 0
  let slot = font.slotOf(at shr PageShift)
  pageData[(slot shl PageShift) + (at and (FontPageBytes - 1))].int

proc u16(font: FileFont, at: int): int {.inline.} =
  (font.u8(at) shl 8) or font.u8(at + 1)

proc i16(font: FileFont, at: int): int {.inline.} =
  cast[int16](font.u16(at).uint16).int

proc u32(font: FileFont, at: int): int {.inline.} =
  (font.u16(at) shl 16) or font.u16(at + 2)

proc bytes(font: FileFont, at, len: int): string =
  ## `len` bytes of the file from `at`, page by page.
  result = newString(len)
  var done = 0
  while done < len:
    let
      pos = at + done
      inPage = pos and (FontPageBytes - 1)
      n = min(len - done, FontPageBytes - inPage)
    if pos < 0 or pos + n > font.fileSize:
      fail("a read past the end of the file")
    let slot = font.slotOf(pos shr PageShift)
    copyMem(result[done].addr, pageData[(slot shl PageShift) + inPage].addr, n)
    done += n

proc tagAt(font: FileFont, at: int): uint32 =
  font.u32(at).uint32

proc tagOf(s: string): uint32 =
  (s[0].uint32 shl 24) or (s[1].uint32 shl 16) or (s[2].uint32 shl 8) or s[3].uint32

template tag(s: static string): uint32 =
  const t = tagOf(s) # made by the compiler, not at each comparison
  t

proc readPairTables(font: FileFont, list: int) =
  ## The pair positioning subtables (lookup type 2, as opentype.nim reads
  ## them; an extension lookup is not) that adjust the x advance.
  for i in 0 ..< font.u16(list):
    let lookup = list + font.u16(list + 2 + i * 2)
    if font.u16(lookup) != 2:
      continue
    for s in 0 ..< font.u16(lookup + 4):
      let at = lookup + font.u16(lookup + 6 + s * 2)
      if font.u16(at) notin [1, 2] or (font.u16(at + 4) and 0b100) == 0:
        continue
      let
        coverage = at + font.u16(at + 2)
        count = font.u16(coverage + 2)
      if count == 0 or font.pairTables.len >= 2048:
        continue
      let (first, last) =
        case font.u16(coverage)
        of 1: (font.u16(coverage + 4), font.u16(coverage + 4 + (count - 1) * 2))
        of 2: (font.u16(coverage + 4), font.u16(coverage + 4 + (count - 1) * 6 + 2))
        else: (1, 0)
      if last < first:
        continue
      font.pairTables.add at.uint32
      font.pairTables.add (first or (last shl 16)).uint32

proc openFileFont*(path: string, fileSize: int): FileFont {.raises: [PixieError].} =
  ## The TrueType font in the file at `path` (`fileSize` bytes), read where it
  ## lies. Reads its table directory and headers now and nothing else.
  result = FileFont(path: path, fileSize: fileSize)
  result.id = uint32(atomicInc(fileFontIds))
  let font = result
  if fileSize < 12:
    fail("too short")
  let version = font.tagAt(0)
  if version == tag("OTTO"):
    fail("CFF outlines (convert it with frameos/tools/font_for_card.py)")
  if version == tag("ttcf"):
    fail("a collection (split it with frameos/tools/font_for_card.py)")
  if version == tag("wOFF") or version == tag("wOF2"):
    fail("WOFF (convert it with frameos/tools/font_for_card.py)")
  if version != 0x00010000'u32 and version != tag("true"):
    fail("not a TrueType file")
  let numTables = font.u16(4)
  if 12 + numTables * 16 > fileSize:
    fail("table directory out of bounds")
  var head, hhea, maxp, os2, post, cmap, gpos, glyfLen = 0
  for i in 0 ..< numTables:
    let
      r = 12 + i * 16
      t = font.tagAt(r)
      offset = font.u32(r + 8)
      length = font.u32(r + 12)
    if offset + length > fileSize:
      continue # a table that is not all there is not read
    if t == tag("head"): head = offset
    elif t == tag("hhea"): hhea = offset
    elif t == tag("maxp"): maxp = offset
    elif t == tag("hmtx"): font.hmtxAt = offset
    elif t == tag("loca"): font.locaAt = offset
    elif t == tag("glyf"):
      font.glyfAt = offset
      glyfLen = length
    elif t == tag("cmap"): cmap = offset
    elif t == tag("OS/2"):
      os2 = offset
      if length < 90 or font.u16(offset) < 2:
        os2 = -offset # no cap height
    elif t == tag("post"): post = offset
    elif t == tag("GPOS"): gpos = offset
    elif t == tag("kern"): font.kernAt = offset
    elif t == tag("CBLC"): font.cblcAt = offset
    elif t == tag("CBDT"): font.cbdtAt = offset
  if head == 0 or hhea == 0 or maxp == 0 or font.hmtxAt == 0 or cmap == 0:
    fail("a required table is missing")
  if font.cblcAt == 0 or font.cbdtAt == 0:
    font.cblcAt = 0
    font.cbdtAt = 0
  if (font.glyfAt == 0 or font.locaAt == 0) and font.cblcAt == 0:
    fail("no glyf outlines (convert it with frameos/tools/font_for_card.py)")
  if font.glyfAt == 0 or font.locaAt == 0:
    font.glyfAt = 0 # colour bitmaps only
    font.locaAt = 0
  font.glyfEnd = font.glyfAt + glyfLen
  font.unitsPerEm = font.u16(head + 18)
  font.longLoca = font.i16(head + 50) != 0
  font.ascender = font.i16(hhea + 4)
  font.descender = font.i16(hhea + 6)
  font.lineGap = font.i16(hhea + 8)
  font.numHMetrics = font.u16(hhea + 34)
  font.numGlyphs = font.u16(maxp + 4)
  if os2 != 0:
    font.strikeoutSize = font.i16(abs(os2) + 26)
    font.strikeoutPosition = font.i16(abs(os2) + 28)
    if os2 > 0:
      font.capHeight = font.i16(os2 + 88)
  if post != 0:
    font.underlinePosition = font.i16(post + 8)
    font.underlineThickness = font.i16(post + 10)
  if font.unitsPerEm == 0 or font.numHMetrics == 0 or font.numGlyphs == 0:
    fail("empty metrics")
  # The character map: the last format 12 subtable of the Unicode or Windows
  # platforms, else the last format 4 (opentype.nim reads them all, the last
  # mapping read winning; a format 12 maps all a format 4 does).
  for i in 0 ..< font.u16(cmap + 2):
    let
      r = cmap + 4 + i * 8
      platform = font.u16(r)
      at = cmap + font.u32(r + 4)
      format = font.u16(at)
    if platform != 0 and platform != 3:
      continue
    if format == 12 or (format == 4 and font.cmapFormat != 12):
      font.cmapAt = at
      font.cmapFormat = format
  if font.cmapFormat == 0:
    fail("no Unicode character map")
  if gpos != 0 and font.u16(gpos) == 1:
    font.kernAt = 0 # GPOS kerns, not the kern table (as opentype.nim)
    font.readPairTables(gpos + font.u16(gpos + 8))
  if font.kernAt != 0 and font.u16(font.kernAt) != 0:
    font.kernAt = 0 # only the Windows kern table, as opentype.nim

proc lookupGlyph(font: FileFont, rune: int32): int =
  let r = rune.int
  if r < 0:
    return -1
  let at = font.cmapAt
  if font.cmapFormat == 12:
    var
      lo = 0
      hi = font.u32(at + 12) - 1
    while lo <= hi:
      let
        mid = (lo + hi) div 2
        g = at + 16 + mid * 12
      if r < font.u32(g):
        hi = mid - 1
      elif r > font.u32(g + 4):
        lo = mid + 1
      else:
        return (font.u32(g + 8) + r - font.u32(g)) and 0xFFFF
    return -1
  if r >= 0xFFFF:
    return -1
  let segCount = font.u16(at + 6) div 2
  var
    lo = 0
    hi = segCount - 1
  # The first segment whose end is at or past the rune.
  while lo < hi:
    let mid = (lo + hi) div 2
    if font.u16(at + 14 + mid * 2) < r:
      lo = mid + 1
    else:
      hi = mid
  if segCount == 0 or font.u16(at + 14 + lo * 2) < r:
    return -1
  let
    starts = at + 16 + segCount * 2
    start = font.u16(starts + lo * 2)
  if r < start:
    return -1
  let
    delta = font.u16(starts + segCount * 2 + lo * 2)
    rangeAt = starts + segCount * 4 + lo * 2
    rangeOffset = font.u16(rangeAt)
  if rangeOffset == 0:
    return (r + delta) and 0xFFFF
  result = font.u16(rangeAt + rangeOffset + (r - start) * 2)
  if result != 0:
    result = (result + delta) and 0xFFFF

proc glyphIdOf*(font: FileFont, rune: int32): int {.raises: [].} =
  ## The glyph `rune` maps to, -1 for none.
  let slot = font.memoSlot(rune.uint32)
  if memoPair(runeMemo, slot, it.font == font.id and it.rune == rune) >= 0:
    return runeMemo[slot].glyph
  result = font.lookupGlyph(rune)
  memoPut(runeMemo, slot, RuneMemo(font: font.id, rune: rune, glyph: result.int32))

proc hasGlyph*(font: FileFont, rune: int32): bool {.raises: [].} =
  font.glyphIdOf(rune) >= 0

proc glyphMemoOf(font: FileFont, glyph: int): int =
  ## The glyph's memo entry, made (its advance read) if it was not there.
  result = font.memoSlot(glyph.uint32 xor 0x5bd1e995'u32)
  if memoPair(glyphMemo, result, it.font == font.id and it.glyph == glyph) < 0:
    memoPut(glyphMemo, result, GlyphMemo(font: font.id, glyph: glyph.int32,
      advance: font.u16(font.hmtxAt + min(glyph, font.numHMetrics - 1) * 4).uint16))

proc advance*(font: FileFont, glyph: int): int {.raises: [].} =
  if glyph < 0 or glyph >= font.numGlyphs:
    return 0
  glyphMemo[font.glyphMemoOf(glyph)].advance.int

proc locaOf(font: FileFont, glyph: int): int =
  if font.longLoca: font.u32(font.locaAt + glyph * 4)
  else: font.u16(font.locaAt + glyph * 2) * 2

proc readBox(font: FileFont, glyph: int, memo: var GlyphMemo) =
  memo.boxKind = 1
  let
    start = font.locaOf(glyph)
    stop = font.locaOf(glyph + 1)
  if stop == start:
    memo.boxKind = 2 # no outline: an empty box
    memo.box = [0'i16, 0, 0, 0]
    return
  let at = font.glyfAt + start
  if stop < start or at + 10 > font.glyfEnd:
    return
  for i in 0 .. 3:
    memo.box[i] = font.i16(at + 2 + i * 2).int16
  if memo.box[2] >= memo.box[0] and memo.box[3] >= memo.box[1]:
    memo.boxKind = 2

proc glyphBox*(font: FileFont, glyph: int, box: var Rect): bool {.raises: [].} =
  ## The glyph's box as its glyf header states it, in font units, y down like
  ## `getGlyphPath`'s outline; false where there is none to read. True with
  ## an empty box for a glyph with no outline.
  box = rect(0, 0, 0, 0)
  if glyph < 0 or glyph >= font.numGlyphs or font.glyfAt == 0:
    return false
  let slot = font.glyphMemoOf(glyph)
  if glyphMemo[slot].boxKind == 0:
    font.readBox(glyph, glyphMemo[slot])
  if glyphMemo[slot].boxKind != 2:
    return false
  let
    b = glyphMemo[slot].box
    xMin = b[0].float32
    yMin = b[1].float32
    xMax = b[2].float32
    yMax = b[3].float32
  box = rect(xMin, -yMax, xMax - xMin, yMax - yMin)
  true

proc parseGlyfGlyph*(font: FileFont, glyphId: uint16, recursionDepth: int): Path {.
    raises: [PixieError], gcsafe.} =
  if recursionDepth > 64:
    fail("composite glyph recursion")
  let glyph = glyphId.int
  if glyph >= font.numGlyphs:
    fail("glyph " & $glyph)
  if font.glyfAt == 0:
    return newPath() # a colour bitmap font has no outlines
  let
    start = font.locaOf(glyph)
    stop = font.locaOf(glyph + 1)
  if stop <= start:
    return newPath()
  if stop - start > MaxRecordBytes or font.glyfAt + stop > font.glyfEnd:
    fail("glyph record out of bounds")
  let record = font.bytes(font.glyfAt + start, stop - start)
  if record.len < 10:
    fail("glyph record")
  let numberOfContours = cast[int16]((record[0].uint16 shl 8) or record[1].uint16).int
  if numberOfContours < 0:
    font.parseCompositeGlyph(record, 10, recursionDepth)
  else:
    parseGlyphPath(record, 10, numberOfContours)

proc getGlyphPath*(font: FileFont, rune: int32): Path {.raises: [PixieError], gcsafe.} =
  ## The rune's outline in font units, y down (as opentype's): read now, the
  ## caller's to keep. The `.notdef` glyph for a rune the font does not map.
  let glyph = max(font.glyphIdOf(rune), 0)
  result = font.parseGlyfGlyph(glyph.uint16, 0)
  result.transform(scale(vec2(1, -1)))

proc coverageIndex(font: FileFont, at, glyph: int): int =
  ## The glyph's index in the coverage table at `at`, -1 for none.
  var
    lo = 0
    hi = font.u16(at + 2) - 1
  case font.u16(at)
  of 1:
    while lo <= hi:
      let
        mid = (lo + hi) div 2
        g = font.u16(at + 4 + mid * 2)
      if g < glyph: lo = mid + 1
      elif g > glyph: hi = mid - 1
      else: return mid
  of 2:
    while lo <= hi:
      let
        mid = (lo + hi) div 2
        r = at + 4 + mid * 6
      if font.u16(r + 2) < glyph: lo = mid + 1
      elif font.u16(r) > glyph: hi = mid - 1
      else: return font.u16(r + 4) + glyph - font.u16(r)
  else:
    discard
  -1

proc classOf(font: FileFont, at, glyph: int): int =
  ## The glyph's class in the class definition at `at`, 0 for none.
  case font.u16(at)
  of 1:
    let first = font.u16(at + 2)
    if glyph >= first and glyph - first < font.u16(at + 4):
      return font.u16(at + 6 + (glyph - first) * 2)
  of 2:
    var
      lo = 0
      hi = font.u16(at + 2) - 1
    while lo <= hi:
      let
        mid = (lo + hi) div 2
        r = at + 4 + mid * 6
      if font.u16(r + 2) < glyph: lo = mid + 1
      elif font.u16(r) > glyph: hi = mid - 1
      else: return font.u16(r + 4)
  else:
    discard
  0

proc bitsSet(n: int): int =
  var n = n
  while n > 0:
    n = n and (n - 1)
    inc result

proc pairAdjustment(font: FileFont, at, left, right: int, value: var int): bool =
  ## The pair's nonzero x advance in the pair positioning subtable at `at`,
  ## false where it has none (opentype.nim keeps only nonzero ones).
  let
    format = font.u16(at)
    valueFormat1 = font.u16(at + 4)
    valueFormat2 = font.u16(at + 6)
  if (valueFormat1 and 0b100) == 0 or format notin [1, 2]:
    return false
  let covered = font.coverageIndex(at + font.u16(at + 2), left)
  if covered < 0:
    return false
  let
    xAdvanceAt = 2 * bitsSet(valueFormat1 and 0b11)
    recordBytes = 2 * (bitsSet(valueFormat1) + bitsSet(valueFormat2))
  if format == 1:
    if covered >= font.u16(at + 8):
      return false
    let pairSet = at + font.u16(at + 10 + covered * 2)
    var
      lo = 0
      hi = font.u16(pairSet) - 1
    while lo <= hi:
      let
        mid = (lo + hi) div 2
        r = pairSet + 2 + mid * (2 + recordBytes)
        g = font.u16(r)
      if g < right: lo = mid + 1
      elif g > right: hi = mid - 1
      else:
        value = font.i16(r + 2 + xAdvanceAt)
        return value != 0
    return false
  let
    class1 = font.classOf(at + font.u16(at + 8), left)
    class2 = font.classOf(at + font.u16(at + 10), right)
    class1Count = font.u16(at + 12)
    class2Count = font.u16(at + 14)
  if class1 >= class1Count or class2 >= class2Count:
    return false
  value = font.i16(at + 16 + (class1 * class2Count + class2) * recordBytes + xAdvanceAt)
  value != 0

proc lookupKerning(font: FileFont, left, right: int): int =
  var t = 0
  while t < font.pairTables.len:
    let span = font.pairTables[t + 1].int
    if left >= (span and 0xFFFF) and left <= (span shr 16):
      var value: int
      if font.pairAdjustment(font.pairTables[t].int, left, right, value):
        return value
    t += 2
  if font.kernAt != 0:
    var at = font.kernAt + 4
    let key = (left shl 16) or right
    for t in 0 ..< font.u16(font.kernAt + 2):
      let
        length = font.u16(at + 2)
        coverage = font.u16(at + 4)
        pairs = font.u16(at + 6)
      if font.u16(at) == 0 and (coverage and 1) != 0 and (coverage shr 8) == 0:
        var
          lo = 0
          hi = pairs - 1
        while lo <= hi:
          let
            mid = (lo + hi) div 2
            r = at + 14 + mid * 6
            k = font.u32(r)
          if k < key: lo = mid + 1
          elif k > key: hi = mid - 1
          else:
            let v = font.i16(r + 4)
            if (coverage and 0b1000) != 0: result = v
            else: result += v
            break
      if length < 14:
        break
      at += length


proc kerning*(font: FileFont, left, right: int): int {.raises: [].} =
  ## The x advance between two glyphs, in font units: the first GPOS pair
  ## subtable, in lookup order, that covers `left` and has a nonzero entry
  ## for the pair (opentype's `getKerningAdjustment`); the kern table's
  ## pairs in a font without GPOS.
  if left < 0 or right < 0 or (font.pairTables.len == 0 and font.kernAt == 0):
    return 0
  let
    pair = (left.uint32 shl 16) or (right.uint32 and 0xFFFF)
    slot = font.memoSlot(pair, 1)
  if memoPair(kernMemo, slot, it.font == font.id and it.pair == pair) >= 0:
    return kernMemo[slot].value.int
  result = font.lookupKerning(left, right)
  memoPut(kernMemo, slot, KernMemo(font: font.id, pair: pair, value: result.int32))


proc bitmapRecord(font: FileFont, strike, glyph: int,
    dataAt, dataLen, format: var int, metricsAt: var int): bool =
  ## Where the glyph's data is in the strike whose BitmapSize record is at
  ## `strike`, in place: its index subtable found in the strike's array and
  ## read for this glyph (opentype.nim `parseCbdtIndexSubTable`'s formats).
  ## `metricsAt`: the subtable's big metrics (formats 2 and 5), 0 for none.
  let
    arrayAt = font.cblcAt + font.u32(strike)
    count = font.u32(strike + 8)
  for t in 0 ..< min(count, 4096):
    let
      entry = arrayAt + t * 8
      first = font.u16(entry)
      last = font.u16(entry + 2)
    if glyph < first or glyph > last or last < first:
      continue
    let
      sub = arrayAt + font.u32(entry + 4)
      indexFormat = font.u16(sub)
      imageFormat = font.u16(sub + 2)
      imageAt = font.cbdtAt + font.u32(sub + 4)
      j = glyph - first
    if imageFormat notin [17, 18, 19]:
      return false # only PNG glyphs, as opentype.nim
    format = imageFormat
    metricsAt = 0
    case indexFormat
    of 1, 3:
      let (o1, o2) =
        if indexFormat == 1: (font.u32(sub + 8 + j * 4), font.u32(sub + 12 + j * 4))
        else: (font.u16(sub + 8 + j * 2), font.u16(sub + 10 + j * 2))
      dataAt = imageAt + o1
      dataLen = o2 - o1
    of 2:
      dataLen = font.u32(sub + 8)
      dataAt = imageAt + j * dataLen
      metricsAt = sub + 12
    of 4:
      var
        lo = 0
        hi = font.u32(sub + 8) - 1
      dataLen = 0
      while lo <= hi:
        let
          mid = (lo + hi) div 2
          r = sub + 12 + mid * 4
          g = font.u16(r)
        if g < glyph: lo = mid + 1
        elif g > glyph: hi = mid - 1
        else:
          dataAt = imageAt + font.u16(r + 2)
          dataLen = font.u16(r + 6) - font.u16(r + 2)
          break
    of 5:
      dataLen = font.u32(sub + 8)
      metricsAt = sub + 12
      var
        lo = 0
        hi = font.u32(sub + 20) - 1
        found = -1
      while lo <= hi:
        let
          mid = (lo + hi) div 2
          g = font.u16(sub + 24 + mid * 2)
        if g < glyph: lo = mid + 1
        elif g > glyph: hi = mid - 1
        else:
          found = mid
          break
      if found < 0:
        return false
      dataAt = imageAt + found * dataLen
    else:
      return false
    return dataLen > 0
  false

proc bestStrike(font: FileFont, glyph: int, sizePx: float32): int =
  ## The strike to draw `glyph` from at `sizePx`: the smallest at least that
  ## big, else the largest (opentype.nim `getBitmapGlyph`); -1 for none.
  result = -1
  var bestPpem = 0
  for s in 0 ..< min(font.u32(font.cblcAt + 4), 64):
    let strike = font.cblcAt + 8 + s * 48
    var dataAt, dataLen, format, metricsAt: int
    if not font.bitmapRecord(strike, glyph, dataAt, dataLen, format, metricsAt):
      continue
    let ppem = font.u8(strike + 44)
    if result == -1 or (bestPpem.float32 < sizePx and ppem > bestPpem) or
        (bestPpem.float32 >= sizePx and ppem.float32 >= sizePx and ppem < bestPpem):
      result = strike
      bestPpem = ppem

proc hasColorGlyph*(font: FileFont, rune: int32): bool {.raises: [].} =
  ## Whether the rune has a colour bitmap glyph (remembered with its advance).
  if font.cblcAt == 0:
    return false
  let glyph = font.glyphIdOf(rune)
  if glyph < 0 or glyph >= font.numGlyphs:
    return false
  let slot = font.glyphMemoOf(glyph)
  if glyphMemo[slot].colorKind == 0:
    glyphMemo[slot].colorKind = if font.bestStrike(glyph, 0) >= 0: 2 else: 1
  glyphMemo[slot].colorKind == 2

proc bitmapGlyph*(font: FileFont, rune: int32, sizePx: float32,
    bitmap: var BitmapGlyph): bool {.raises: [PixieError].} =
  ## The rune's colour bitmap glyph for `sizePx`: its PNG read from CBDT now,
  ## and where it goes, as opentype.nim `getBitmapGlyph` gives it.
  if font.cblcAt == 0:
    return false
  let glyph = font.glyphIdOf(rune)
  if glyph < 0:
    return false
  let strike = font.bestStrike(glyph, sizePx)
  if strike < 0:
    return false
  var dataAt, dataLen, format, metricsAt: int
  discard font.bitmapRecord(strike, glyph, dataAt, dataLen, format, metricsAt)
  var pngAt, pngLen: int
  case format
  of 17, 18:
    bitmap.xOffset = cast[int8](font.u8(dataAt + 2).uint8).float32
    bitmap.yOffset = cast[int8](font.u8(dataAt + 3).uint8).float32
    pngLen = if format == 17: font.u32(dataAt + 5) else: font.u32(dataAt + 8)
    pngAt = dataAt + (if format == 17: 9 else: 12)
  of 19:
    if metricsAt == 0:
      return false
    bitmap.xOffset = cast[int8](font.u8(metricsAt + 2).uint8).float32
    bitmap.yOffset = cast[int8](font.u8(metricsAt + 3).uint8).float32
    pngLen = font.u32(dataAt)
    pngAt = dataAt + 4
  else:
    return false
  if pngLen <= 0 or pngLen > MaxPngBytes:
    return false
  bitmap.png = font.bytes(pngAt, pngLen)
  bitmap.ppem = font.u8(strike + 44).float32
  bitmap.yOffsetIsBottom = false
  true

when defined(release):
  {.pop.}

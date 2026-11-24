import pixie/common, pixie/fontformats/opentype, pixie/paths

# Glyph records and tables that lie about themselves. The font readers run
# with the checks off in a release, so each lie must end in a PixieError, not
# in a read outside the bytes. Found by fuzz_file_font and fuzz_indexed_font
# (2026-11-24) under AddressSanitizer.

proc be16(v: int): string =
  result.add char((v shr 8) and 0xff)
  result.add char(v and 0xff)

proc simpleGlyph(endPoints: openArray[int], points: int): string =
  ## A simple glyph's record past its header: end points, no instructions,
  ## every point on the curve with one-byte positive x and y.
  for e in endPoints:
    result.add be16(e)
  result.add be16(0)
  for _ in 0 ..< points:
    result.add char(0x01 or 0x02 or 0x04 or 0x10 or 0x20)
  for p in 0 ..< points:
    result.add char(p)
  for p in 0 ..< points:
    result.add char(p)

proc refused(record: string, contours: int): bool =
  try:
    discard parseGlyphPath(record, 0, contours)
  except PixieError:
    return true

block:
  # A whole glyph reads.
  let path = parseGlyphPath(simpleGlyph([2, 5], 6), 0, 2)
  doAssert $path != ""

block:
  # The second contour ends before the first: an empty, backwards slice.
  doAssert refused(simpleGlyph([5, 2], 3), 2)
  # A contour that ends past the last point (the last one says 3 points).
  doAssert refused(simpleGlyph([9, 2], 3), 2)
  # Instructions said to run past the record.
  var record = simpleGlyph([2], 3)
  record[2] = '\xff'
  record[3] = '\xff'
  doAssert refused(record, 1)

block:
  # Two contours ending at the same point: the second has no points and is
  # skipped, the glyph still reads.
  let path = parseGlyphPath(simpleGlyph([2, 2, 5], 6), 0, 3)
  doAssert $path != ""

echo "broken font records: ok"

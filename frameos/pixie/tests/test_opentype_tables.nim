include pixie/fontformats/opentype

# Tables of the whole-file reader whose offsets and lengths come from the
# font and were read without a check against it: a CFF INDEX and the name
# table's records (found by fuzz_opentype, 2026-11-24, once its CFF
# charstring finding was fixed). The reader runs with the checks off in a
# release, so each must end in a PixieError.

proc be16(v: int): string =
  result.add char((v shr 8) and 0xff)
  result.add char(v and 0xff)

proc indexRefused(buf: string): bool =
  var start = 0
  try:
    discard buf.parseCFFIndex(start)
  except PixieError:
    return true

block:
  # A whole INDEX of two objects reads.
  var start = 0
  let objects = parseCFFIndex(be16(2) & "\x01" & "\x01\x03\x04" & "abc", start)
  doAssert objects == @["ab", "c"]
  doAssert start == 9

block:
  doAssert indexRefused(be16(2))                                # no offset size
  doAssert indexRefused(be16(2) & "\x00" & "\x01\x03\x04abc")   # offset size 0
  doAssert indexRefused(be16(2) & "\x05" & "\x01\x03\x04abc")   # offset size 5
  doAssert indexRefused(be16(2) & "\x01" & "\x01\x03")          # offsets cut short
  doAssert indexRefused(be16(2) & "\x01" & "\x01\xc8\x04abc")   # going back
  doAssert indexRefused(be16(2) & "\x01" & "\x00\x03\x04abc")   # an offset of 0
  doAssert indexRefused(be16(2) & "\x01" & "\x01\x03\xff" & "abc") # past the end
  doAssert indexRefused("\x00")                                 # no count

proc nameRefused(buf: string): bool =
  try:
    discard parseNameTable(buf, 0)
  except PixieError:
    return true

block:
  # format 0, one record, strings at 18: the record says 100 bytes at 0.
  let head = be16(0) & be16(1) & be16(18)
  let record = be16(1) & be16(0) & be16(0) & be16(1) & be16(100) & be16(0)
  doAssert nameRefused(head & record & "FrameOS")
  # The same record told the truth reads.
  let honest = be16(1) & be16(0) & be16(0) & be16(1) & be16(7) & be16(0)
  doAssert parseNameTable(head & honest & "FrameOS", 0).nameRecords[0].text == "FrameOS"

echo "opentype tables: ok"

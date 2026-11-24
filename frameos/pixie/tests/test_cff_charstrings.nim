include pixie/fontformats/opentype

# Type 2 charstrings that ask for what is not there: an operand from an empty
# stack, operand bytes past the end, a subroutine that does not exist, calls
# nested without end, and calls that fan out without end. The reader runs with
# the checks off in a release, so each must end in a PixieError (found by
# fuzz_opentype on a CFF font with one byte changed, 2026-11-24).

proc cffWith(subrs: seq[string] = @[], globals: seq[string] = @[]): CffTable =
  result = CffTable(topDict: CFFTopDict(), globalSubrIndex: globals)
  result.topDict.subrIndex = subrs
  result.topDict.subrsBias = calcCFFSubroutineBias(subrs)

proc refused(cff: CffTable, code: string): bool =
  try:
    discard cff.parseCFFCharstring(code, 0)
  except PixieError:
    return true

const
  push0 = "\x8b"        # 0
  pushMinus107 = "\x20" # -107: subroutine 0 once the bias (107) is added
  rmoveto = "\x15"
  rlineto = "\x05"
  callsubr = "\x0a"
  callgsubr = "\x1d"
  endchar = "\x0e"

block:
  # A whole glyph reads.
  let cff = cffWith()
  discard cff.parseCFFCharstring(push0 & push0 & rmoveto & "\x8c\x8c" & rlineto & endchar, 0)

block:
  let cff = cffWith()
  doAssert cff.refused(rmoveto)                       # nothing to move by
  doAssert cff.refused(push0 & rmoveto)               # one of two
  doAssert cff.refused("\x8c" & rlineto)              # an odd lineto
  doAssert cff.refused("\x1c\x01")                    # a shortint cut short
  doAssert cff.refused("\xf7")                        # a two-byte number cut short
  doAssert cff.refused("\xff\x00\x00")                # a fixed number cut short
  doAssert cff.refused(push0 & callsubr)              # no subroutines at all
  doAssert cff.refused(push0 & callgsubr)             # no global ones either
  doAssert cff.refused(callsubr)                      # no index to call

block:
  # A subroutine that calls itself.
  let cff = cffWith(subrs = @[pushMinus107 & callsubr])
  doAssert cff.refused(pushMinus107 & callsubr)

block:
  # Subroutines that call the next one a hundred times each, four deep:
  # 100 million calls, refused long before.
  var subrs: seq[string]
  for level in 0 ..< 4:
    var code = ""
    for _ in 0 ..< 100:
      code.add char(139 - 107 + level + 1) & callsubr
    subrs.add code
  subrs.add "\x0b" # return
  let cff = cffWith(subrs = subrs)
  doAssert cff.refused(pushMinus107 & callsubr)

block:
  # The font's own glyphs still draw.
  let font = parseOpenType(readFile("tests/fonts/NotoEmoji.otf"))
  doAssert font.cff != nil
  var drawn = 0
  for rune in [0x263A, 0x2764, 0x1F600, 0x1F44D]:
    if font.getGlyphPath(Rune(rune)).computeBounds().w > 0:
      inc drawn
  doAssert drawn > 0

echo "CFF charstrings: ok"

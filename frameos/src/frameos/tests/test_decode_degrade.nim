# The decode-budget plan check must never surface as an error frame when a
# degraded decode would fit: decodeIntoTargetWithDegrade retries a refused
# into-target decode at reduced resolution and upscales. These tests drive
# the ladder with a scripted decode proc so the mechanics are pinned without
# depending on a real decoder's plan arithmetic.
import std/[strutils, unittest]
import pixie
import pixie/fileformats/jpeg as pixie_jpeg
import pixie/fileformats/png as pixie_png
import ../utils/image
import ../utils/memory

proc budgetRefusal(): ref PixieError =
  newException(PixieError,
    "JPEG decode of 2048x3072 needs 1869K of decode buffers, over the " &
    "1807K memory budget")

suite "decodeIntoTargetWithDegrade":
  test "a decode that fits runs once, straight into the target":
    let target = newImage(120, 160)
    var calls: seq[(int, int)] = @[]
    let got = decodeIntoTargetWithDegrade(target, fitCover,
      proc(dst: Image) =
        calls.add((dst.width, dst.height))
        dst.fill(rgbx(10, 20, 30, 255)))
    check got == target
    check calls == @[(120, 160)]
    check target[0, 0] == rgbx(10, 20, 30, 255)

  test "a budget refusal retries at half resolution and upscales":
    let target = newImage(120, 160)
    var calls: seq[(int, int)] = @[]
    let got = decodeIntoTargetWithDegrade(target, fitCover,
      proc(dst: Image) =
        calls.add((dst.width, dst.height))
        if dst.width == target.width:
          raise budgetRefusal()
        dst.fill(rgbx(200, 100, 50, 255)))
    check got == target
    check calls == @[(120, 160), (60, 80)]
    # The degraded decode's pixels were stretched over the full target.
    check target[0, 0] == rgbx(200, 100, 50, 255)
    check target[119, 159] == rgbx(200, 100, 50, 255)

  test "keeps halving while the plan still refuses":
    let target = newImage(120, 160)
    var calls: seq[(int, int)] = @[]
    discard decodeIntoTargetWithDegrade(target, fitCover,
      proc(dst: Image) =
        calls.add((dst.width, dst.height))
        if dst.width > 30:
          raise budgetRefusal()
        dst.fill(rgbx(1, 2, 3, 255)))
    check calls == @[(120, 160), (60, 80), (30, 40)]
    check target[64, 64] == rgbx(1, 2, 3, 255)

  test "re-raises the original refusal when every rung is refused":
    let target = newImage(120, 160)
    var calls = 0
    expect PixieError:
      discard decodeIntoTargetWithDegrade(target, fitCover,
        proc(dst: Image) =
          inc calls
          raise budgetRefusal())
    check calls == 3

  test "non-budget errors pass through without any retry":
    let target = newImage(120, 160)
    var calls = 0
    try:
      discard decodeIntoTargetWithDegrade(target, fitCover,
        proc(dst: Image) =
          inc calls
          raise newException(PixieError, "progressive JPEGs cannot stream"))
      check false
    except PixieError as e:
      check "progressive" in e.msg
    check calls == 1

# streamDecodeInto is the one format dispatch behind the SD-card, spilled
# and socket decode paths. Each caller keeps its own error policy, so the
# contract to pin here is narrow: the source is rewound before every decode
# attempt, decoder errors come out untouched, and "no decoder" is a false.
type Cursor = ref object
  data: string
  pos: int

proc source(c: Cursor, reads: ref int = nil): JpegSourceProc =
  result = proc(dst: pointer, maxBytes: int): int =
    if reads != nil:
      inc reads[]
    let n = min(maxBytes, c.data.len - c.pos)
    if n <= 0:
      return 0
    copyMem(dst, unsafeAddr c.data[c.pos], n)
    c.pos += n
    n

proc gradient(width, height: int): Image =
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      result.unsafe[x, y] = rgbx(
        uint8((x * 3) mod 256), uint8((y * 5) mod 256), uint8((x + y) mod 256), 255)

suite "streamDecodeInto":
  let encoded = encodePng(gradient(320, 480))

  test "a format without a streaming decoder is a false, source untouched":
    let cursor = Cursor(data: encoded)
    var rewinds = 0
    check not streamDecodeInto("GIF", cursor.source(), encoded.len,
      newImage(64, 48), fitCover, proc() = inc rewinds)
    check rewinds == 0
    check cursor.pos == 0

  test "a JPEG of unknown length is a false: its reader needs the count":
    var rewinds = 0
    check not streamDecodeInto("JPEG", Cursor(data: encoded).source(), 0,
      newImage(64, 48), fitCover, proc() = inc rewinds)
    check rewinds == 0

  test "rewinds before the decode and matches the buffered decode":
    for fit in [fitCover, fitContain, fitStretch]:
      let expected = newImage(120, 90)
      var buffered = encoded
      discard decodeImageScaledInto(buffered, expected, fit)

      # Start mid-stream: only a rewind that runs first can make this work.
      let cursor = Cursor(data: encoded, pos: 17)
      var rewinds = 0
      let target = newImage(120, 90)
      check streamDecodeInto("PNG", cursor.source(), encoded.len, target, fit,
        proc() =
          inc rewinds
          cursor.pos = 0)
      check rewinds == 1
      for i in 0 ..< target.dataLen:
        check target.data[i] == expected.data[i]

  test "decoder errors propagate untouched for the caller's policy":
    let cursor = Cursor(data: encoded[0 ..< encoded.len div 2])
    var rewinds = 0
    expect PixieError:
      discard streamDecodeInto("PNG", cursor.source(), encoded.len,
        newImage(64, 48), fitCover, proc() =
          inc rewinds
          cursor.pos = 0)
    check rewinds == 1

  test "every degrade rung rewinds the source before decoding again":
    # pixie plans a streamed PNG at 3 source scanlines + a fixed inflate
    # overhead + 64 bytes per target column (png.nim, checkDecodeBudget in
    # decodePngScaledIntoStreaming). For this 320-wide RGBA source into a
    # 240x180 target that is ~87.7K at full size, ~80.1K at half and ~76.2K
    # at quarter; a 78K headroom refuses the first two rungs. The ladder
    # refreshes the budget from the headroom between rungs, hence the
    # override rather than a direct pixie budget.
    availableRenderBytesOverride = 78_000
    refreshDecodeBudgetInto()
    defer:
      availableRenderBytesOverride = 0
      refreshDecodeBudgetInto()
    let cursor = Cursor(data: encoded)
    var rewinds = 0
    var reads = new int
    let target = newImage(240, 180)
    check streamDecodeInto("PNG", cursor.source(reads), encoded.len, target, fitCover,
      proc() =
        inc rewinds
        cursor.pos = 0)
    check rewinds == 3
    check reads[] > 3
    # The quarter-res rung's pixels were stretched over the whole target.
    check target[0, 0].a == 255
    check target[239, 179].a == 255

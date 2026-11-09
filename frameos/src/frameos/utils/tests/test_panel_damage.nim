import std/unittest
import ../panel_damage

proc canvas(width, height: int; value: uint8 = 255): seq[uint8] =
  result = newSeq[uint8](width * height)
  for i in 0 ..< result.len:
    result[i] = value

template pixels(data: seq[uint8]): untyped =
  cast[ptr UncheckedArray[uint8]](data[0].unsafeAddr)

template packed(data: seq[uint8]): untyped =
  cast[ptr UncheckedArray[uint8]](data[0].addr)

proc bit(buf: seq[uint8]; rowBytes, px, py: int): bool =
  (buf[py * rowBytes + (px shr 3)] and (0x80'u8 shr (px and 7))) != 0

proc runsOf(current, previous: seq[uint8]; width, height: int): tuple[runs: seq[ChangedRun], area: int] =
  result.area = changedRuns(pixels(current), pixels(previous), width, height, result.runs)

proc run(y, left, right: int): ChangedRun = (y.int32, left.int32, right.int32)

suite "changedRuns":
  test "identical canvases have nothing changed":
    let a = canvas(16, 8)
    let found = runsOf(a, a, 16, 8)
    check found.area == 0
    check found.runs.len == 0

  test "a run is bounded by what changed":
    let a = canvas(64, 4)
    var b = canvas(64, 4)
    b[1 * 64 + 5] = 0
    b[2 * 64 + 9] = 0
    b[2 * 64 + 12] = 0
    let found = runsOf(b, a, 64, 4)
    check found.runs == @[run(1, 5, 6), run(2, 9, 13)]
    check found.area == 5

  test "the last pixel of a row counts":
    let a = canvas(16, 2)
    var b = canvas(16, 2)
    b[16 + 15] = 0
    check runsOf(b, a, 16, 2).runs == @[run(1, 15, 16)]

  test "changes far apart on a row are separate runs":
    let a = canvas(100, 1)
    var b = canvas(100, 1)
    b[10] = 0
    b[90] = 0
    check runsOf(b, a, 100, 1).runs == @[run(0, 10, 11), run(0, 90, 91)]

  test "changes close together are one run":
    let a = canvas(100, 1)
    var b = canvas(100, 1)
    b[10] = 0
    b[20] = 0
    check runsOf(b, a, 100, 1).runs == @[run(0, 10, 21)]

  test "a crosshair that moved costs its pixels, not what is between its lines":
    let a = canvas(100, 100)
    var b = canvas(100, 100)
    for y in 0 ..< 100:
      b[y * 100 + 10] = 0
      b[y * 100 + 90] = 0
    check runsOf(b, a, 100, 100).area == 200

  test "too scattered a change is reported as the whole canvas":
    let a = canvas(800, 480)
    var b = canvas(800, 480)
    for y in 0 ..< 480:
      for x in countup(0, 799, 40):
        b[y * 800 + x] = 0
    check runsOf(b, a, 800, 480).area == 800 * 480

suite "packRuns1bpp":
  test "writes only the bits of the runs":
    let gray = canvas(16, 4, 0)
    var buf = newSeq[uint8](2 * 4)
    for i in 0 ..< buf.len:
      buf[i] = 0xFF
    packRuns1bpp(pixels(gray), 16, 4, packed(buf), 2, [run(1, 4, 8), run(2, 4, 8)], 0)
    check buf == @[0xFF'u8, 0xFF, 0xF0, 0xFF, 0xF0, 0xFF, 0xFF, 0xFF]

  test "two runs on a row":
    let gray = canvas(16, 1, 0)
    var buf = newSeq[uint8](2)
    buf[0] = 0xFF
    buf[1] = 0xFF
    packRuns1bpp(pixels(gray), 16, 1, packed(buf), 2, [run(0, 0, 2), run(0, 14, 16)], 0)
    check buf == @[0x3F'u8, 0xFC]

  test "sets white over black":
    let gray = canvas(8, 1, 255)
    var buf = newSeq[uint8](1)
    packRuns1bpp(pixels(gray), 8, 1, packed(buf), 1, [run(0, 0, 3)], 0)
    check buf[0] == 0xE0'u8

  test "lands where the frame's rotation puts it":
    # A 2x4 canvas on a 4x2 panel rotated 270: (x, y) lands at (y, srcW - 1 - x).
    let gray = canvas(2, 4, 255)
    var buf = newSeq[uint8](2)
    packRuns1bpp(pixels(gray), 2, 4, packed(buf), 1, [run(0, 0, 1)], 270)
    check bit(buf, 1, 0, 1)
    check not bit(buf, 1, 0, 0)

  test "a mid grey comes out dithered":
    let gray = canvas(8, 8, 128)
    var buf = newSeq[uint8](8)
    var runs: seq[ChangedRun]
    for y in 0 ..< 8:
      runs.add run(y, 0, 8)
    packRuns1bpp(pixels(gray), 8, 8, packed(buf), 1, runs, 0)
    var white = 0
    for py in 0 ..< 8:
      for px in 0 ..< 8:
        if bit(buf, 1, px, py): inc white
    check white in 28 .. 36

  test "no error crosses an unchanged row":
    # Dithered alone, the third row starts from no error, whatever is above.
    let gray = canvas(8, 3, 128)
    var together = newSeq[uint8](3)
    packRuns1bpp(pixels(gray), 8, 3, packed(together), 1, [run(0, 0, 8), run(2, 0, 8)], 0)
    var alone = newSeq[uint8](3)
    packRuns1bpp(pixels(gray), 8, 3, packed(alone), 1, [run(2, 0, 8)], 0)
    check together[2] == alone[2]

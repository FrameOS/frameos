## qrEncode / qrImage (utils/qr.nim). The vectors were made with QRgen
## 3.1.0, the package this module replaced (2026-10-18): the same modules at
## every version where the layout changes, in every mode, and the same pixels
## for every way the QR app styles a code. Every code here also decodes back
## to its text with zxing-cpp.
##
## Anti-aliased edges are pinned in black and white only: pixie blends a
## colored partial coverage on SIMD paths that round differently per
## architecture (a colored digest from an arm64 Mac failed on x86_64 CI,
## QRgen's pixels included), while black over white and the colored square
## modules (a fill and plain pixel writes) are the same bytes everywhere.

import std/unittest
import pixie

import ../qr

const
  Bytes = "abcdefghijklmnopqrstuvwxyz0123456789:/.?=&-_"
  Upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:"
  Digits = "123456789" # no '0': QRgen wrote a group with a leading zero short
  ZeroGroupDigest = 1131980539'u32 # "0123456789"
  LeadingZerosDigest = 1645139099'u32 # "007"
  ModuleVectors = [
    (Bytes, 16, 1, 21, 2943597573'u32),
    (Bytes, 17, 2, 25, 3809250939'u32),
    (Bytes, 31, 3, 25, 1714683793'u32),
    (Bytes, 32, 4, 29, 1955984052'u32),
    (Bytes, 133, 5, 41, 1698708961'u32),
    (Bytes, 134, 6, 45, 1777933279'u32),
    (Bytes, 153, 7, 45, 2425817741'u32),
    (Bytes, 154, 8, 49, 536127861'u32),
    (Bytes, 229, 9, 53, 47082563'u32),
    (Bytes, 230, 10, 57, 1590294501'u32),
    (Bytes, 270, 11, 57, 1618559699'u32),
    (Bytes, 271, 12, 61, 573777267'u32),
    (Bytes, 424, 13, 69, 2425572921'u32),
    (Bytes, 425, 14, 73, 3899151557'u32),
    (Bytes, 457, 15, 73, 3420970771'u32),
    (Bytes, 458, 16, 77, 3921277985'u32),
    (Bytes, 928, 17, 101, 3458906429'u32),
    (Bytes, 929, 18, 105, 2238104293'u32),
    (Bytes, 1366, 19, 121, 3518321553'u32),
    (Bytes, 1367, 20, 125, 664795661'u32),
    (Bytes, 1464, 21, 125, 1392195115'u32),
    (Bytes, 1465, 22, 129, 2077834336'u32),
    (Bytes, 1951, 23, 145, 3502247588'u32),
    (Bytes, 1952, 24, 149, 163386918'u32),
    (Bytes, 2302, 25, 157, 3828988067'u32),
    (Bytes, 2303, 26, 161, 3396869213'u32),
    (Bytes, 2952, 27, 177, 577948679'u32),
    (Upper, 24, 28, 21, 859260459'u32),
    (Upper, 25, 29, 25, 636550018'u32),
    (Upper, 46, 30, 25, 1611393652'u32),
    (Upper, 47, 31, 29, 1000602444'u32),
    (Upper, 194, 32, 41, 819067085'u32),
    (Upper, 195, 33, 45, 1804923705'u32),
    (Upper, 223, 34, 45, 4269136089'u32),
    (Upper, 224, 35, 49, 1911744741'u32),
    (Upper, 334, 36, 53, 1138352354'u32),
    (Upper, 335, 37, 57, 3684746247'u32),
    (Upper, 394, 38, 57, 1374688224'u32),
    (Upper, 395, 39, 61, 186833670'u32),
    (Upper, 618, 40, 69, 3149171793'u32),
    (Upper, 619, 41, 73, 3030039007'u32),
    (Upper, 666, 42, 73, 2577257991'u32),
    (Upper, 667, 43, 77, 3723552644'u32),
    (Upper, 1351, 44, 101, 203243468'u32),
    (Upper, 1352, 45, 105, 1759623613'u32),
    (Upper, 1989, 46, 121, 4293721123'u32),
    (Upper, 1990, 47, 125, 2320586320'u32),
    (Upper, 2131, 48, 125, 271041026'u32),
    (Upper, 2132, 49, 129, 3773832069'u32),
    (Upper, 2839, 50, 145, 1283777864'u32),
    (Upper, 2840, 51, 149, 145440028'u32),
    (Upper, 3350, 52, 157, 775562844'u32),
    (Upper, 3351, 53, 161, 1088684629'u32),
    (Upper, 4295, 54, 177, 828714697'u32),
    (Digits, 40, 55, 21, 3220194719'u32),
    (Digits, 41, 56, 25, 4013484741'u32),
    (Digits, 76, 57, 25, 946622521'u32),
    (Digits, 77, 58, 29, 4272579157'u32),
    (Digits, 321, 59, 41, 1556112893'u32),
    (Digits, 322, 60, 45, 1276697647'u32),
    (Digits, 369, 61, 45, 779462663'u32),
    (Digits, 370, 62, 49, 3814700251'u32),
    (Digits, 551, 63, 53, 362945263'u32),
    (Digits, 552, 64, 57, 914377111'u32),
    (Digits, 651, 65, 57, 681008178'u32),
    (Digits, 652, 66, 61, 1389856187'u32),
    (Digits, 1021, 67, 69, 4271777256'u32),
    (Digits, 1022, 68, 73, 3196739447'u32),
    (Digits, 1100, 69, 73, 257574972'u32),
    (Digits, 1101, 70, 77, 496223420'u32),
    (Digits, 2231, 71, 101, 3169493101'u32),
    (Digits, 2232, 72, 105, 1409850923'u32),
    (Digits, 3282, 73, 121, 4122233872'u32),
    (Digits, 3283, 74, 125, 968241035'u32),
    (Digits, 3516, 75, 125, 1866964932'u32),
    (Digits, 3517, 76, 129, 810012390'u32),
    (Digits, 4685, 77, 145, 449563458'u32),
    (Digits, 4686, 78, 149, 881925086'u32),
    (Digits, 5528, 79, 157, 3482768951'u32),
    (Digits, 5529, 80, 161, 3190116585'u32),
    (Digits, 7088, 81, 177, 555768869'u32),
  ]
  RenderVectors = [
    ("frameos", 200, 1, 0.0, 0.0, 0.0, "#000000", "#ffffff", 200, 209071301'u32),
    ("frameos", 200, 1, 30.0, 0.0, 0.0, "#000000", "#ffffff", 200, 1066028512'u32),
    ("frameos", 333, 2, 100.0, 0.0, 0.0, "#000000", "#ffffff", 333, 2124292993'u32),
    ("frameos", 257, 0, 0.0, 50.0, 0.0, "#000000", "#ffffff", 257, 166341560'u32),
    ("frameos", 512, 1, 0.0, 0.0, 25.0, "#000000", "#ffffff", 512, 699118229'u32),
    ("frameos", 512, 5, 30.0, 40.0, 20.0, "#000000", "#ffffff", 512, 4147063363'u32),
    ("frameos", 301, 3, 0.0, 0.0, 0.0, "#123456", "#fedcba", 301, 594382184'u32),
    ("frameos", 21, 0, 10.0, 100.0, 100.0, "#000000", "#ffffff", 21, 1135138613'u32),
    ("frameos", 5, 1, 30.0, 0.0, 0.0, "#000000", "#ffffff", 5, 783964881'u32),
    ("http://frame.local:8787/c?k=secret", 200, 1, 0.0, 0.0, 0.0, "#000000", "#ffffff", 200, 1813852645'u32),
    ("http://frame.local:8787/c?k=secret", 200, 1, 30.0, 0.0, 0.0, "#000000", "#ffffff", 200, 4235977138'u32),
    ("http://frame.local:8787/c?k=secret", 333, 2, 100.0, 0.0, 0.0, "#000000", "#ffffff", 333, 2312567167'u32),
    ("http://frame.local:8787/c?k=secret", 257, 0, 0.0, 50.0, 0.0, "#000000", "#ffffff", 257, 2110244683'u32),
    ("http://frame.local:8787/c?k=secret", 512, 1, 0.0, 0.0, 25.0, "#000000", "#ffffff", 512, 1247313413'u32),
    ("http://frame.local:8787/c?k=secret", 512, 5, 30.0, 40.0, 20.0, "#000000", "#ffffff", 512, 1598612279'u32),
    ("http://frame.local:8787/c?k=secret", 301, 3, 0.0, 0.0, 0.0, "#123456", "#fedcba", 301, 2206361160'u32),
    ("http://frame.local:8787/c?k=secret", 21, 0, 10.0, 100.0, 100.0, "#000000", "#ffffff", 21, 223692881'u32),
    ("http://frame.local:8787/c?k=secret", 5, 1, 30.0, 0.0, 0.0, "#000000", "#ffffff", 5, 783964881'u32),
  ]
  FrameosRows = [
    "#######.....#.#######",
    "#.....#...#.#.#.....#",
    "#.###.#...###.#.###.#",
    "#.###.#.#.#.#.#.###.#",
    "#.###.#.##..#.#.###.#",
    "#.....#..#.#..#.....#",
    "#######.#.#.#.#######",
    ".....................",
    "##...###...#....##...",
    "##.#...###.###..#.##.",
    ".####.#.#.#.#.##...#.",
    "######....#########.#",
    "#.###.##.#########..#",
    "........#...#..##.#.#",
    "#######.##.#.#...###.",
    "#.....#.###...##.###.",
    "#.###.#...##.#..#..#.",
    "#.###.#..#.####.##...",
    "#.###.#....###..#.###",
    "#.....#.########.##..",
    "#######.###.#......#.",
  ]

proc sample(alphabet: string, n, seed: int): string =
  var x = uint32(seed) * 2654435761'u32 + 1
  for _ in 0 ..< n:
    x = x * 1664525'u32 + 1013904223'u32
    result.add alphabet[int(x shr 16) mod alphabet.len]

proc fnv(bytes: openArray[uint8]): uint32 =
  result = 2166136261'u32
  for b in bytes:
    result = (result xor b) * 16777619'u32

proc moduleDigest(qr: QrCode): uint32 =
  var bytes: seq[uint8]
  for y in 0 ..< qr.size:
    for x in 0 ..< qr.size:
      bytes.add uint8(qr[x, y])
  fnv(bytes)

proc imageDigest(img: Image): uint32 =
  var bytes: seq[uint8]
  for y in 0 ..< img.height:
    for x in 0 ..< img.width:
      let c = img[x, y]
      bytes.add [c.r, c.g, c.b, c.a]
  fnv(bytes)

suite "qrEncode":
  test "a small code, module by module":
    let qr = qrEncode("frameos")
    check qr.size == FrameosRows.len
    for y, row in FrameosRows:
      var drawn = ""
      for x in 0 ..< qr.size: drawn.add(if qr[x, y]: '#' else: '.')
      check drawn == row

  test "QRgen's modules in every mode, version and layout change":
    for (alphabet, length, seed, size, digest) in ModuleVectors:
      let qr = qrEncode(sample(alphabet, length, seed))
      check qr.size == size
      check moduleDigest(qr) == digest

  test "the smallest version that holds one character more, as QRgen chose":
    check qrEncode(sample(Bytes, 16, 1)).size == 21
    check qrEncode(sample(Bytes, 17, 1)).size == 25 # version 1 holds 17 bytes
    check qrEncode("").size == 21

  test "numeric groups with a leading zero are 10 bits":
    # QRgen wrote "012" in 7 bits: its code for this text scanned as
    # "0987173088". These decode to their text.
    check moduleDigest(qrEncode("0123456789")) == ZeroGroupDigest
    check moduleDigest(qrEncode("007")) == LeadingZerosDigest

  test "text past version 40 raises":
    check qrEncode(sample(Bytes, 2952, 1)).size == 177
    expect ValueError:
      discard qrEncode(sample(Bytes, 2953, 1))

suite "qrImage":
  test "QRgen's pixels for each style":
    for (text, pixels, padding, alRad, moRad, moSep, dark, light, side, digest) in RenderVectors:
      let img = qrEncode(text).qrImage(pixels, padding, dark = parseHtmlColor(dark), light = parseHtmlColor(light),
        alRad = alRad, moRad = moRad, moSep = moSep)
      check img.width == side
      check img.height == side
      check imageDigest(img) == digest

  test "colors on rounded modules and finders":
    let dark = parseHtmlColor("#204080")
    let light = parseHtmlColor("#f0f0e0")
    # 25 modules of 20 px, 2 of padding: the top-left finder starts at 40.
    let img = qrEncode("frameos").qrImage(500, 2, dark = dark, light = light, alRad = 30, moRad = 40, moSep = 20)
    check img.width == 500
    check img[5, 5] == light.rgbx            # quiet zone
    check img[40 + 70, 40 + 10] == dark.rgbx # outer ring, top edge
    check img[40 + 30, 40 + 30] == light.rgbx # light ring
    check img[40 + 70, 40 + 70] == dark.rgbx # center square
    for y in 0 ..< img.height:
      for x in 0 ..< img.width:
        let c = img[x, y]
        check c.a == 255
        check c.r in dark.rgbx.r .. light.rgbx.r

  test "draws opaque, whatever the alpha":
    let img = qrEncode("frameos").qrImage(46, 1, dark = color(0, 0, 0, 0.5), light = color(1, 1, 1, 0))
    check img[0, 0] == rgbx(255, 255, 255, 255)
    check img[3, 3] == rgbx(0, 0, 0, 255)

  test "fewer pixels than modules is a blank square":
    let img = qrEncode("frameos").qrImage(5)
    check img.width == 5
    for y in 0 ..< img.height:
      for x in 0 ..< img.width:
        check img[x, y] == rgbx(255, 255, 255, 255)

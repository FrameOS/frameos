## qrEncode / qrImage (utils/qr.nim). Every vector below decodes back to its
## text with zxing-cpp (checked when it was pinned); the byte-mode ones fill
## their version, at the versions where the layout changes.

import std/unittest
import pixie

import ../qr

const
  Bytes = "abcdefghijklmnopqrstuvwxyz0123456789:/.?=&-_"

proc sample(alphabet: string, n, seed: int): string =
  var x = uint32(seed) * 2654435761'u32 + 1
  for _ in 0 ..< n:
    x = x * 1664525'u32 + 1013904223'u32
    result.add alphabet[int(x shr 16) mod alphabet.len]

proc moduleDigest(qr: QrCode): uint32 =
  result = 2166136261'u32
  for y in 0 ..< qr.size:
    for x in 0 ..< qr.size:
      result = (result xor uint32(qr[x, y])) * 16777619'u32

let Vectors = [
  ("frameos", 21, 1092847045'u32),
  ("http://frame.local:8787/c?k=secret", 29, 2336303363'u32),
  ("WIFI:T:WPA;S:FrameOS-Setup;P:frame1234;;", 29, 3030313940'u32),
  ("HTTPS://FRAMEOS.NET/", 21, 1683183127'u32), # alphanumeric
  ("0123456789", 21, 1131980539'u32), # numeric, a group with a leading zero
  ("007", 21, 1645139099'u32),
  (sample(Bytes, 154, 7), 45, 1472810855'u32), # version 7: version bits
  (sample(Bytes, 271, 10), 57, 3994478101'u32), # 10: 16-bit count
  (sample(Bytes, 458, 14), 73, 2673108651'u32), # 14: three alignment rows
  (sample(Bytes, 1465, 27), 125, 917999271'u32),
  (sample(Bytes, 1952, 32), 145, 2665142426'u32), # 32: the odd alignment step
  (sample(Bytes, 2953, 40), 177, 119264329'u32),
]

suite "qrEncode":
  test "codes that scan":
    for (text, size, digest) in Vectors:
      let qr = qrEncode(text)
      check qr.size == size
      check moduleDigest(qr) == digest

  test "the smallest version that fits":
    check qrEncode("").size == 21
    check qrEncode(sample(Bytes, 17, 1)).size == 21 # version 1 holds 17 bytes
    check qrEncode(sample(Bytes, 18, 1)).size == 25

  test "text past version 40 raises":
    expect ValueError:
      discard qrEncode(sample(Bytes, 2954, 1))

suite "qrImage":
  test "every style keeps the quiet zone light and the finders dark":
    let qr = qrEncode("frameos")
    # 21 modules + 2 * 2 of padding = 25 modules of 20 px; the finder starts at 40
    for (alRad, moRad, moSep) in [(0.0, 0.0, 0.0), (30.0, 0.0, 0.0), (100.0, 0.0, 0.0), (0.0, 40.0, 20.0)]:
      let img = qr.qrImage(500, 2, dark = parseHtmlColor("#204080"), light = parseHtmlColor("#f0f0e0"),
        alRad = alRad, moRad = moRad, moSep = moSep)
      check img.width == 500
      check img[5, 5] == rgbx(0xf0, 0xf0, 0xe0, 255)
      check img[40 + 70, 40 + 70] == rgbx(0x20, 0x40, 0x80, 255) # center square
      check img[40 + 30, 40 + 70] == rgbx(0xf0, 0xf0, 0xe0, 255) # light ring, left side

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

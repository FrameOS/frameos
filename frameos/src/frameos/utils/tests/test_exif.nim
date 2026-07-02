import std/[json, math, unittest]

import ../exif

type
  IfdEntry = object
    tag: int
    typ: int
    count: int
    inline: string
    data: string

  ExifBuilder = object
    bigEndian: bool

proc u16(b: ExifBuilder, value: int): string =
  if b.bigEndian:
    result.add chr((value shr 8) and 0xFF)
    result.add chr(value and 0xFF)
  else:
    result.add chr(value and 0xFF)
    result.add chr((value shr 8) and 0xFF)

proc u32(b: ExifBuilder, value: int64): string =
  if b.bigEndian:
    for shift in [24, 16, 8, 0]:
      result.add chr(int((value shr shift) and 0xFF))
  else:
    for shift in [0, 8, 16, 24]:
      result.add chr(int((value shr shift) and 0xFF))

proc asciiEntry(b: ExifBuilder, tag: int, value: string): IfdEntry =
  let payload = value & "\0"
  if payload.len <= 4:
    IfdEntry(tag: tag, typ: 2, count: payload.len, inline: payload)
  else:
    IfdEntry(tag: tag, typ: 2, count: payload.len, data: payload)

proc shortEntry(b: ExifBuilder, tag, value: int): IfdEntry =
  IfdEntry(tag: tag, typ: 3, count: 1, inline: b.u16(value))

proc longEntry(b: ExifBuilder, tag: int, value: int64): IfdEntry =
  IfdEntry(tag: tag, typ: 4, count: 1, inline: b.u32(value))

proc rationalEntry(b: ExifBuilder, tag: int, num, den: int64): IfdEntry =
  IfdEntry(tag: tag, typ: 5, count: 1, data: b.u32(num) & b.u32(den))

proc rational3Entry(b: ExifBuilder, tag: int,
    values: array[3, tuple[num, den: int64]]): IfdEntry =
  var data = ""
  for (num, den) in values:
    data.add b.u32(num)
    data.add b.u32(den)
  IfdEntry(tag: tag, typ: 5, count: 3, data: data)

proc buildIfd(b: ExifBuilder, entries: seq[IfdEntry], baseOffset: int): string =
  var dataOffset = baseOffset + 2 + entries.len * 12 + 4
  var dir = b.u16(entries.len)
  var dataArea = ""
  for entry in entries:
    dir.add b.u16(entry.tag)
    dir.add b.u16(entry.typ)
    dir.add b.u32(entry.count)
    if entry.data == "":
      var inline = entry.inline
      while inline.len < 4:
        inline.add '\0'
      dir.add inline
    else:
      dir.add b.u32(dataOffset)
      dataArea.add entry.data
      dataOffset += entry.data.len
  dir.add b.u32(0)
  dir & dataArea

proc ifdSize(entries: seq[IfdEntry]): int =
  result = 2 + entries.len * 12 + 4
  for entry in entries:
    result += entry.data.len

proc buildTiff(b: ExifBuilder, ifd0Entries: seq[IfdEntry],
    exifEntries: seq[IfdEntry] = @[], gpsEntries: seq[IfdEntry] = @[]): string =
  var ifd0 = ifd0Entries
  if exifEntries.len > 0:
    ifd0.add b.longEntry(0x8769, 0)
  if gpsEntries.len > 0:
    ifd0.add b.longEntry(0x8825, 0)
  let exifOffset = 8 + ifdSize(ifd0)
  let gpsOffset = exifOffset + (if exifEntries.len > 0: ifdSize(exifEntries) else: 0)
  ifd0 = ifd0Entries
  if exifEntries.len > 0:
    ifd0.add b.longEntry(0x8769, exifOffset)
  if gpsEntries.len > 0:
    ifd0.add b.longEntry(0x8825, gpsOffset)
  result = (if b.bigEndian: "MM" else: "II") & b.u16(42) & b.u32(8)
  result.add b.buildIfd(ifd0, 8)
  if exifEntries.len > 0:
    result.add b.buildIfd(exifEntries, exifOffset)
  if gpsEntries.len > 0:
    result.add b.buildIfd(gpsEntries, gpsOffset)

proc jpegWithApp1(tiff: string): string =
  let payload = "Exif\0\0" & tiff
  let segmentLen = payload.len + 2
  result = "\xFF\xD8"
  result.add "\xFF\xE0\x00\x04\x00\x00" # dummy APP0 before APP1
  result.add "\xFF\xE1"
  result.add chr((segmentLen shr 8) and 0xFF)
  result.add chr(segmentLen and 0xFF)
  result.add payload
  result.add "\xFF\xD9"

proc fullExifJpeg(bigEndian: bool): string =
  let b = ExifBuilder(bigEndian: bigEndian)
  let tiff = b.buildTiff(
    @[
      b.asciiEntry(0x010F, "Canon"),
      b.asciiEntry(0x0110, "Canon EOS R5"),
      b.shortEntry(0x0112, 6),
      b.asciiEntry(0x013B, "Jane Doe"),
      b.asciiEntry(0x8298, "(c) Jane Doe"),
    ],
    @[
      b.rationalEntry(0x829A, 1, 250),
      b.rationalEntry(0x829D, 18, 10),
      b.shortEntry(0x8827, 400),
      b.asciiEntry(0x9003, "2024:06:01 12:34:56"),
      b.rationalEntry(0x920A, 35, 1),
      b.asciiEntry(0xA434, "RF35mm F1.8 MACRO IS STM"),
    ],
    @[
      b.asciiEntry(0x0001, "N"),
      b.rational3Entry(0x0002, [(37'i64, 1'i64), (48'i64, 1'i64), (30'i64, 1'i64)]),
      b.asciiEntry(0x0003, "W"),
      b.rational3Entry(0x0004, [(122'i64, 1'i64), (25'i64, 1'i64), (6'i64, 1'i64)]),
    ]
  )
  jpegWithApp1(tiff)

proc checkFullExif(exif: JsonNode) =
  check exif["make"].getStr() == "Canon"
  check exif["model"].getStr() == "Canon EOS R5"
  check exif["orientation"].getInt() == 6
  check exif["artist"].getStr() == "Jane Doe"
  check exif["copyright"].getStr() == "(c) Jane Doe"
  check exif["exposureTime"].getStr() == "1/250"
  check almostEqual(exif["fNumber"].getFloat(), 1.8)
  check exif["iso"].getInt() == 400
  check exif["dateTimeOriginal"].getStr() == "2024:06:01 12:34:56"
  check almostEqual(exif["focalLength"].getFloat(), 35.0)
  check exif["lensModel"].getStr() == "RF35mm F1.8 MACRO IS STM"
  check abs(exif["gpsLatitude"].getFloat() - (37.0 + 48.0 / 60.0 + 30.0 / 3600.0)) < 1e-9
  check abs(exif["gpsLongitude"].getFloat() + (122.0 + 25.0 / 60.0 + 6.0 / 3600.0)) < 1e-9

suite "exif parser":
  test "extracts all supported fields (little endian)":
    checkFullExif(parseExif(fullExifJpeg(bigEndian = false)))

  test "extracts all supported fields (big endian)":
    checkFullExif(parseExif(fullExifJpeg(bigEndian = true)))

  test "south latitude is negative, north positive":
    let b = ExifBuilder(bigEndian: false)
    let tiff = b.buildTiff(@[], gpsEntries = @[
      b.asciiEntry(0x0001, "S"),
      b.rational3Entry(0x0002, [(12'i64, 1'i64), (30'i64, 1'i64), (0'i64, 1'i64)]),
      b.asciiEntry(0x0003, "E"),
      b.rational3Entry(0x0004, [(45'i64, 1'i64), (0'i64, 1'i64), (0'i64, 1'i64)]),
    ])
    let exif = parseExif(jpegWithApp1(tiff))
    check almostEqual(exif["gpsLatitude"].getFloat(), -12.5)
    check almostEqual(exif["gpsLongitude"].getFloat(), 45.0)

  test "exposure times of a second or longer are formatted in seconds":
    let b = ExifBuilder(bigEndian: false)
    let tiff = b.buildTiff(@[], exifEntries = @[
      b.rationalEntry(0x829A, 5, 2),
    ])
    check parseExif(jpegWithApp1(tiff))["exposureTime"].getStr() == "2.5"

  test "iso stored as LONG is accepted":
    let b = ExifBuilder(bigEndian: true)
    let tiff = b.buildTiff(@[], exifEntries = @[b.longEntry(0x8827, 12800)])
    check parseExif(jpegWithApp1(tiff))["iso"].getInt() == 12800

  test "jpeg without exif yields empty object":
    check parseExif("\xFF\xD8\xFF\xE0\x00\x04\x00\x00\xFF\xD9").len == 0

  test "non-jpeg data yields empty object":
    check parseExif("").len == 0
    check parseExif("hello world, definitely not a jpeg").len == 0
    check parseExif("\x89PNG\r\n\x1a\n").len == 0

  test "zero denominators and zero-count entries are skipped":
    let b = ExifBuilder(bigEndian: false)
    let tiff = b.buildTiff(@[], exifEntries = @[
      b.rationalEntry(0x829A, 1, 0),
      b.rationalEntry(0x829D, 0, 0),
      IfdEntry(tag: 0x8827, typ: 3, count: 0, inline: ""),
    ])
    check parseExif(jpegWithApp1(tiff)).len == 0

  test "every truncation of a valid blob parses without raising":
    for bigEndian in [false, true]:
      let blob = fullExifJpeg(bigEndian)
      for prefixLen in 0 .. blob.len:
        let exif = parseExif(blob[0 ..< prefixLen])
        check exif.kind == JObject

  test "corrupted entry offsets parse without raising":
    let blob = fullExifJpeg(bigEndian = false)
    for position in 0 ..< blob.len:
      var mutated = blob
      mutated[position] = '\xFF'
      check parseExif(mutated).kind == JObject

  test "oversized ifd entry counts are capped":
    let b = ExifBuilder(bigEndian: false)
    var tiff = "II" & b.u16(42) & b.u32(8) & b.u16(0xFFFF)
    check parseExif(jpegWithApp1(tiff)).len == 0

suite "exif summary":
  test "full summary joins camera, lens and shot settings":
    let exif = parseExif(fullExifJpeg(bigEndian = false))
    check exifSummary(exif) ==
      "Canon EOS R5 · RF35mm F1.8 MACRO IS STM · 35mm f/1.8 1/250s ISO 400"

  test "make is prefixed when the model does not repeat it":
    let summary = exifSummary(%*{"make": "Nikon", "model": "Z6"})
    check summary == "Nikon Z6"

  test "partial data skips missing parts":
    check exifSummary(%*{"iso": 400}) == "ISO 400"
    check exifSummary(%*{"model": "X100V", "exposureTime": "1/125"}) ==
      "X100V · 1/125s"
    check exifSummary(newJObject()) == ""
    check exifSummary(newJNull()) == ""

suite "exif metadata merge":
  test "merges parsed exif and summary into metadata":
    var metadata = %*{"path": "/tmp/a.jpg"}
    mergeParsedExif(metadata, fullExifJpeg(bigEndian = false))
    check metadata["exif"]["make"].getStr() == "Canon"
    check metadata["exifSummary"].getStr().len > 0

  test "existing exif keys are not overwritten":
    var metadata = %*{"exif": {"make": "FromExiftool", "Model": "Verbose"}}
    mergeParsedExif(metadata, fullExifJpeg(bigEndian = false))
    check metadata["exif"]["make"].getStr() == "FromExiftool"
    check metadata["exif"]["Model"].getStr() == "Verbose"
    check metadata["exif"]["model"].getStr() == "Canon EOS R5"

  test "leaves metadata untouched when there is nothing to merge":
    var metadata = %*{"path": "/tmp/a.png"}
    mergeParsedExif(metadata, "not a jpeg")
    check not metadata.hasKey("exif")
    check not metadata.hasKey("exifSummary")

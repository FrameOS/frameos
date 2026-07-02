import json
import math
import strutils

## Dependency-free EXIF parser for JPEG bytes. Scans the APP1 segment,
## walks the TIFF IFDs and returns the common photographer fields as JSON.
## Every read is bounds-checked so malformed input never raises: parsing
## simply stops and returns whatever was extracted so far.

const
  ExifScanBytes* = 256 * 1024
  MaxIfdEntries = 512
  MaxAsciiBytes = 1024
  ExifHeader = "Exif\0\0"

const
  TagMake = 0x010F
  TagModel = 0x0110
  TagOrientation = 0x0112
  TagArtist = 0x013B
  TagCopyright = 0x8298
  TagExifIfd = 0x8769
  TagGpsIfd = 0x8825
  TagExposureTime = 0x829A
  TagFNumber = 0x829D
  TagIso = 0x8827
  TagDateTimeOriginal = 0x9003
  TagFocalLength = 0x920A
  TagLensModel = 0xA434
  TagGpsLatitudeRef = 0x0001
  TagGpsLatitude = 0x0002
  TagGpsLongitudeRef = 0x0003
  TagGpsLongitude = 0x0004

type
  TiffReader = object
    data: string
    start: int
    len: int
    bigEndian: bool

proc byteAtRaw(data: string, offset, limit: int): int =
  if offset < 0 or offset >= limit or offset >= data.len:
    return -1
  data[offset].ord

proc byteAt(r: TiffReader, offset: int): int =
  if offset < 0 or offset >= r.len:
    return -1
  let index = r.start + offset
  if index >= r.data.len:
    return -1
  r.data[index].ord

proc readU16(r: TiffReader, offset: int): int =
  let a = r.byteAt(offset)
  let b = r.byteAt(offset + 1)
  if a < 0 or b < 0:
    return -1
  if r.bigEndian: (a shl 8) or b
  else: (b shl 8) or a

proc readU32(r: TiffReader, offset: int): int64 =
  let a = r.byteAt(offset)
  let b = r.byteAt(offset + 1)
  let c = r.byteAt(offset + 2)
  let d = r.byteAt(offset + 3)
  if a < 0 or b < 0 or c < 0 or d < 0:
    return -1
  if r.bigEndian:
    (a.int64 shl 24) or (b.int64 shl 16) or (c.int64 shl 8) or d.int64
  else:
    (d.int64 shl 24) or (c.int64 shl 16) or (b.int64 shl 8) or a.int64

proc typeSize(typ: int): int =
  case typ
  of 1, 2, 6, 7: 1
  of 3, 8: 2
  of 4, 9, 11: 4
  of 5, 10, 12: 8
  else: 0

proc entryType(r: TiffReader, entry: int): int =
  r.readU16(entry + 2)

proc entryCount(r: TiffReader, entry: int): int64 =
  r.readU32(entry + 4)

proc entryValueOffset(r: TiffReader, entry: int): int =
  ## TIFF-relative offset of an entry's value: inline in the 4-byte value
  ## field when it fits, otherwise behind the stored offset.
  let size = typeSize(r.entryType(entry))
  let count = r.entryCount(entry)
  if size <= 0 or count <= 0:
    return -1
  let total = size.int64 * count
  if total <= 4:
    return entry + 8
  let offset = r.readU32(entry + 8)
  if offset < 0 or offset + total > r.len.int64:
    return -1
  offset.int

proc asciiValue(r: TiffReader, entry: int): string =
  if r.entryType(entry) != 2:
    return ""
  let offset = r.entryValueOffset(entry)
  if offset < 0:
    return ""
  let count = min(r.entryCount(entry), MaxAsciiBytes.int64).int
  for i in 0 ..< count:
    let value = r.byteAt(offset + i)
    if value <= 0:
      break
    result.add value.char
  result = result.strip()

proc uintValue(r: TiffReader, entry: int): int64 =
  let offset = r.entryValueOffset(entry)
  if offset < 0:
    return -1
  case r.entryType(entry)
  of 3: r.readU16(offset).int64
  of 4: r.readU32(offset)
  else: -1

proc rationalValue(r: TiffReader, entry: int, index = 0): tuple[num, den: int64] =
  result = (-1'i64, -1'i64)
  if r.entryType(entry) != 5 or index.int64 >= r.entryCount(entry):
    return
  let offset = r.entryValueOffset(entry)
  if offset < 0:
    return
  let num = r.readU32(offset + index * 8)
  let den = r.readU32(offset + index * 8 + 4)
  if num < 0 or den < 0:
    return
  result = (num, den)

proc pointerValue(r: TiffReader, entry: int): int =
  let value = r.uintValue(entry)
  if value < 0 or value >= r.len.int64: -1
  else: value.int

proc formatNumber(value: float): string =
  let rounded = round(value * 10.0) / 10.0
  if rounded == round(rounded):
    $rounded.int64
  else:
    formatFloat(rounded, ffDecimal, 1)

proc formatExposureTime(num, den: int64): string =
  if num <= 0 or den <= 0:
    return ""
  if num >= den:
    return formatNumber(num.float / den.float)
  "1/" & $round(den.float / num.float).int64

proc setAscii(node: JsonNode, key: string, r: TiffReader, entry: int) =
  let value = r.asciiValue(entry)
  if value != "":
    node[key] = %value

proc setRationalFloat(node: JsonNode, key: string, r: TiffReader, entry: int) =
  let (num, den) = r.rationalValue(entry)
  if num >= 0 and den > 0:
    node[key] = %(num.float / den.float)

proc dmsValue(r: TiffReader, entry: int): tuple[value: float, ok: bool] =
  if r.entryType(entry) != 5 or r.entryCount(entry) < 3:
    return (0.0, false)
  const divisors = [1.0, 60.0, 3600.0]
  var total = 0.0
  for i in 0 .. 2:
    let (num, den) = r.rationalValue(entry, i)
    if num < 0 or den <= 0:
      return (0.0, false)
    total += num.float / den.float / divisors[i]
  (total, true)

proc parseExifIfd(node: JsonNode, r: TiffReader, offset: int) =
  let count = r.readU16(offset)
  if count < 0:
    return
  for i in 0 ..< min(count, MaxIfdEntries):
    let entry = offset + 2 + i * 12
    case r.readU16(entry)
    of TagExposureTime:
      let (num, den) = r.rationalValue(entry)
      let exposure = formatExposureTime(num, den)
      if exposure != "":
        node["exposureTime"] = %exposure
    of TagFNumber:
      node.setRationalFloat("fNumber", r, entry)
    of TagIso:
      let iso = r.uintValue(entry)
      # Cap at int32: hostile LONG values would raise RangeDefect from
      # getInt() on 32-bit targets (ESP32, armv7 Pi)
      if iso > 0 and iso <= int32.high.int64:
        node["iso"] = %iso
    of TagDateTimeOriginal:
      node.setAscii("dateTimeOriginal", r, entry)
    of TagFocalLength:
      node.setRationalFloat("focalLength", r, entry)
    of TagLensModel:
      node.setAscii("lensModel", r, entry)
    else:
      discard

proc parseGpsIfd(node: JsonNode, r: TiffReader, offset: int) =
  let count = r.readU16(offset)
  if count < 0:
    return
  var latitudeRef, longitudeRef: string
  var latitude, longitude: tuple[value: float, ok: bool]
  for i in 0 ..< min(count, MaxIfdEntries):
    let entry = offset + 2 + i * 12
    case r.readU16(entry)
    of TagGpsLatitudeRef: latitudeRef = r.asciiValue(entry)
    of TagGpsLatitude: latitude = r.dmsValue(entry)
    of TagGpsLongitudeRef: longitudeRef = r.asciiValue(entry)
    of TagGpsLongitude: longitude = r.dmsValue(entry)
    else: discard
  if latitude.ok:
    node["gpsLatitude"] = %(if latitudeRef == "S": -latitude.value else: latitude.value)
  if longitude.ok:
    node["gpsLongitude"] = %(if longitudeRef == "W": -longitude.value else: longitude.value)

proc parseIfd0(node: JsonNode, r: TiffReader, offset: int) =
  let count = r.readU16(offset)
  if count < 0:
    return
  var exifIfd = -1
  var gpsIfd = -1
  for i in 0 ..< min(count, MaxIfdEntries):
    let entry = offset + 2 + i * 12
    case r.readU16(entry)
    of TagMake: node.setAscii("make", r, entry)
    of TagModel: node.setAscii("model", r, entry)
    of TagOrientation:
      let orientation = r.uintValue(entry)
      if orientation > 0 and orientation <= 8:
        node["orientation"] = %orientation
    of TagArtist: node.setAscii("artist", r, entry)
    of TagCopyright: node.setAscii("copyright", r, entry)
    of TagExifIfd: exifIfd = r.pointerValue(entry)
    of TagGpsIfd: gpsIfd = r.pointerValue(entry)
    else: discard
  if exifIfd >= 0:
    parseExifIfd(node, r, exifIfd)
  if gpsIfd >= 0:
    parseGpsIfd(node, r, gpsIfd)

proc parseTiff(node: JsonNode, data: string, start, len: int) =
  if len < 8:
    return
  var r = TiffReader(data: data, start: start, len: len)
  let order0 = r.byteAt(0)
  let order1 = r.byteAt(1)
  if order0 == ord('M') and order1 == ord('M'):
    r.bigEndian = true
  elif order0 != ord('I') or order1 != ord('I'):
    return
  if r.readU16(2) != 42:
    return
  let ifd0 = r.readU32(4)
  if ifd0 < 0 or ifd0 >= len.int64:
    return
  parseIfd0(node, r, ifd0.int)

proc hasExifHeader(data: string, offset, limit: int): bool =
  for i in 0 ..< ExifHeader.len:
    if byteAtRaw(data, offset + i, limit) != ExifHeader[i].ord:
      return false
  true

proc parseExif*(data: string): JsonNode =
  ## Extract EXIF metadata from JPEG bytes. Only the first 256KB is
  ## scanned: EXIF lives in the APP1 segment at the start of the file.
  ## Returns an empty object when there is no (valid) EXIF data.
  result = newJObject()
  try:
    let limit = min(data.len, ExifScanBytes)
    if byteAtRaw(data, 0, limit) != 0xFF or byteAtRaw(data, 1, limit) != 0xD8:
      return
    var pos = 2
    while byteAtRaw(data, pos, limit) == 0xFF:
      var markerPos = pos + 1
      var marker = byteAtRaw(data, markerPos, limit)
      while marker == 0xFF:
        inc markerPos
        marker = byteAtRaw(data, markerPos, limit)
      if marker < 0 or marker == 0xDA or marker == 0xD9:
        break
      if marker == 0x01 or (marker >= 0xD0 and marker <= 0xD8):
        pos = markerPos + 1
        continue
      let lenHigh = byteAtRaw(data, markerPos + 1, limit)
      let lenLow = byteAtRaw(data, markerPos + 2, limit)
      if lenHigh < 0 or lenLow < 0:
        break
      let segmentLen = (lenHigh shl 8) or lenLow
      if segmentLen < 2:
        break
      if marker == 0xE1 and hasExifHeader(data, markerPos + 3, limit):
        let tiffStart = markerPos + 3 + ExifHeader.len
        let tiffLen = min(segmentLen - 2 - ExifHeader.len, limit - tiffStart)
        parseTiff(result, data, tiffStart, tiffLen)
        return
      pos = markerPos + 1 + segmentLen
  except CatchableError:
    discard

proc exifSummary*(exif: JsonNode): string =
  ## Human-readable one-liner from parseExif output, e.g.
  ## "Canon EOS R5 · RF35mm F1.8 · 35mm f/1.8 1/250s ISO 400".
  if exif.isNil or exif.kind != JObject:
    return ""
  var parts: seq[string]
  let make = exif{"make"}.getStr("").strip()
  let model = exif{"model"}.getStr("").strip()
  var camera = model
  if make != "" and (model == "" or not model.toLowerAscii().startsWith(make.toLowerAscii())):
    camera = (make & " " & model).strip()
  if camera != "":
    parts.add(camera)
  let lens = exif{"lensModel"}.getStr("").strip()
  if lens != "":
    parts.add(lens)
  var shot: seq[string]
  if exif.hasKey("focalLength"):
    shot.add(formatNumber(exif["focalLength"].getFloat()) & "mm")
  if exif.hasKey("fNumber"):
    shot.add("f/" & formatNumber(exif["fNumber"].getFloat()))
  if exif.hasKey("exposureTime"):
    shot.add(exif["exposureTime"].getStr() & "s")
  if exif.hasKey("iso"):
    shot.add("ISO " & $exif["iso"].getBiggestInt())
  if shot.len > 0:
    parts.add(shot.join(" "))
  parts.join(" · ")

proc mergeParsedExif*(metadata: JsonNode, data: string) =
  ## Merge parseExif fields and a summary into an app metadata object.
  ## Keys already present under metadata["exif"] (e.g. from exiftool) win.
  if metadata.isNil or metadata.kind != JObject:
    return
  let exif = parseExif(data)
  if exif.len == 0:
    return
  if not metadata.hasKey("exif") or metadata["exif"].kind != JObject:
    metadata["exif"] = newJObject()
  for key, value in exif.pairs:
    if not metadata["exif"].hasKey(key):
      metadata["exif"][key] = value
  let summary = exifSummary(exif)
  if summary != "":
    metadata["exifSummary"] = %summary

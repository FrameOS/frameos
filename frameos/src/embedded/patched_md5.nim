## Embedded stand-in for `checksums/md5` (installed by config.nims patchFile).
##
## The package computes MD5 in Nim: 3.3 KB of the ESP32-S3 image for the
## transform, its tables and its helpers. The chip's ROM holds MD5 already
## (`esp_rom_md5_*`, RFC 1321, what the IDF checks flash writes with), so on
## the device the package is flash spent on a second copy. FrameOS asks for
## `getMD5` (a saved asset's name, the deployed scenes' fingerprint); the rest
## of the package's API is here too, with the same results. Only the embedded
## build patches it; Pi and backend builds keep the package.

type
  MD5Digest* = array[0..15, uint8]
    ## MD5 checksum of a string, obtained with `toMD5`.
  MD5Context* {.final.} = object
    ## The ROM's `md5_context_t` (88 bytes: state, bit count, block).
    state: array[0..3, uint32]
    count: array[0..1, uint32]
    buffer: array[0..63, uint8]

proc esp_rom_md5_init(context: pointer) {.importc, header: "esp_rom_md5.h".}
proc esp_rom_md5_update(context: pointer, buf: pointer, len: uint32) {.
  importc, header: "esp_rom_md5.h".}
proc esp_rom_md5_final(digest: pointer, context: pointer) {.
  importc, header: "esp_rom_md5.h".}

proc md5Init*(c: var MD5Context) {.raises: [], tags: [], gcsafe.} =
  esp_rom_md5_init(addr c)

proc md5Update*(c: var MD5Context, input: cstring, len: int) {.raises: [],
    tags: [], gcsafe.} =
  if len > 0:
    esp_rom_md5_update(addr c, input, len.uint32)

proc md5Update*(c: var MD5Context, input: openArray[uint8]) {.raises: [],
    tags: [], gcsafe.} =
  if input.len > 0:
    esp_rom_md5_update(addr c, unsafeAddr input[0], input.len.uint32)

proc md5Final*(c: var MD5Context, digest: var MD5Digest) {.raises: [], tags: [],
    gcsafe.} =
  esp_rom_md5_final(addr digest, addr c)

proc toMD5*(s: string): MD5Digest =
  var c: MD5Context
  md5Init(c)
  md5Update(c, s.cstring, s.len)
  md5Final(c, result)

proc `$`*(d: MD5Digest): string =
  const digits = "0123456789abcdef"
  result = newString(32)
  for i in 0..15:
    result[2 * i] = digits[(d[i].int shr 4) and 0xF]
    result[2 * i + 1] = digits[d[i].int and 0xF]

proc getMD5*(s: string): string =
  $toMD5(s)

proc `==`*(D1, D2: MD5Digest): bool =
  for i in 0..15:
    if D1[i] != D2[i]: return false
  return true

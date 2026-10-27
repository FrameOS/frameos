## Embedded stand-in for `zippy/crc` (installed by config.nims patchFile).
##
## zippy computes CRC-32 slicing-by-8, with an 8,192-byte table built at
## compile time. The ESP32-S3's ROM already holds the same CRC-32 (the zlib
## one: polynomial 0xEDB88320, inverted before and after) as
## `esp_rom_crc32_le`, so on the device the table is flash spent on a copy.
## Every CRC on the frame comes through here: zippy's gzip trailer, and
## pixie's PNG chunks by way of patched_crc32.nim.
##
## `esp_rom_crc32_le(0, buf, len)` is zlib's `crc32(0, buf, len)`, which is
## what zippy's `crc32(src, len)` returns: the same checksum, not another one.
## Only the embedded build patches it; Pi and backend builds keep zippy as
## its author wrote it.

proc esp_rom_crc32_le(crc: uint32, buf: pointer, len: uint32): uint32 {.
  importc, header: "esp_rom_crc.h".}

proc crc32*(src: pointer, len: int): uint32 =
  if len <= 0:
    return 0
  esp_rom_crc32_le(0, src, len.uint32)

proc crc32*(src: string): uint32 {.inline.} =
  crc32(src.cstring, src.len)

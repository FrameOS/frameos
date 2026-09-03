## Embedded stand-in for `crunchy/crc32` (installed by config.nims patchFile).
##
## crunchy (pixie's checksum dependency) and zippy ship the same slicing-by-8
## CRC-32, each with its own 8,192-byte table built at compile time. Both end
## up in the ESP32 image, which runs at ~91% of its OTA slot, so the second
## copy is 8 KB of flash spent on a table that is already there. zippy is
## linked either way — the gzip path needs it — so on the device crunchy's
## entry points forward to zippy's.
##
## Same polynomial, same convention, same results: this is a de-duplication,
## not a different checksum. Only the embedded build patches it; Pi and
## backend builds keep crunchy as its author wrote it.

import zippy/crc as zippy_crc

proc crc32*(src: pointer, len: int): uint32 {.inline.} =
  zippy_crc.crc32(src, len)

proc crc32*(data: openarray[byte]): uint32 =
  if data.len <= 0:
    zippy_crc.crc32(nil, 0)
  else:
    zippy_crc.crc32(data[0].unsafeAddr, data.len)

proc crc32*(data: string): uint32 {.inline.} =
  zippy_crc.crc32(data.cstring, data.len)

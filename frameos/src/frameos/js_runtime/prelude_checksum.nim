## A checksum of a prelude's source that comes out the same at compile time
## in Nim's VM and at run time on any target: FNV-1a over the bytes in
## explicit 32-bit arithmetic. std/hashes was not that (a 64-bit host hash
## did not convert to the 32-bit target's Hash, 2026-11-07).

proc preludeChecksum*(s: string): uint32 =
  result = 0x811c9dc5'u32
  for c in s:
    result = (result xor uint32(ord(c))) * 0x01000193'u32

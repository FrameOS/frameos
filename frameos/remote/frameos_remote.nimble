# Package

version       = "0.1.0"
author        = "Marius Andra"
description   = "FrameOS Remote"
license       = "AGPL"
srcDir        = "src"
binDir        = "build"
bin           = @["frameos_remote"]


# Dependencies

requires "nim >= 2.2.4"
requires "ws >= 0.5.0"
requires "jsony >= 1.1.5"
requires "nimcrypto >= 0.6.0"
requires "checksums >= 0.2.1"
# 0.10.19+: zippy 0.10.16's gzip uncompress divides by zero on 32-bit targets
# (gzip.nim `dst.len mod (1 shl 32)`), killing every armv6/armhf binary.
requires "zippy >= 0.10.19"

task test, "Run tests":
  exec "testament pattern './tests/*.nim' --lineTrace:on"

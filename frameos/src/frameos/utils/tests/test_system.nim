import std/unittest

import ../system

suite "system utils":
  test "getAvailableDiskSpace returns bytes for existing paths":
    check getAvailableDiskSpace("/") > 0

  test "getAvailableDiskSpace returns -1 for missing path":
    check getAvailableDiskSpace("/definitely/not/a/real/path") == -1

  test "blocksToBytes stays 64-bit past the 32-bit ceiling":
    # 8.1M blocks of 4 KiB = a 33 GB card: the product a 32-bit frame used to
    # compute in 32-bit ints, raising OverflowDefect for every metrics sample.
    check blocksToBytes(8_110_000'i64, 4096'i64) == 33_218_560_000'i64
    check blocksToBytes(1'i64 shl 40, 4096'i64) == (1'i64 shl 52)

  test "blocksToBytes treats unknown sizes as zero":
    check blocksToBytes(0'i64, 4096'i64) == 0
    check blocksToBytes(1024'i64, 0'i64) == 0
    check blocksToBytes(-1'i64, 4096'i64) == 0

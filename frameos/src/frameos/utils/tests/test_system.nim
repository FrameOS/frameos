import std/unittest

import ../system

suite "system utils":
  test "getAvailableDiskSpace returns bytes for existing paths":
    check getAvailableDiskSpace("/") > 0

  test "getAvailableDiskSpace returns -1 for missing path":
    check getAvailableDiskSpace("/definitely/not/a/real/path") == -1

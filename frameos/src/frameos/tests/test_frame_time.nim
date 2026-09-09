import std/[os, times, unittest]

import frameos/utils/frame_time

suite "frameNow":
  test "unpinned, it is the wall clock":
    delEnv("FRAMEOS_E2E_FIXED_EPOCH")
    let before = now()
    let sample = frameNow()
    check abs((sample - before).inSeconds) <= 2

  test "FRAMEOS_E2E_FIXED_EPOCH pins the instant, read in UTC":
    putEnv("FRAMEOS_E2E_FIXED_EPOCH", "1710254400") # 2024-03-12T14:40:00Z
    defer: delEnv("FRAMEOS_E2E_FIXED_EPOCH")
    let pinned = frameNow()
    check pinned.year == 2024
    check pinned.month == mMar
    check pinned.monthday == 12
    check pinned.hour == 14
    check pinned.minute == 40
    check pinned.format("yyyy-MM-dd HH:mm:ss") == "2024-03-12 14:40:00"
    # Junk is ignored rather than trusted.
    putEnv("FRAMEOS_E2E_FIXED_EPOCH", "soon")
    check abs((frameNow() - now()).inSeconds) <= 2

## What a streamed decode logs and when it renews the run's deadline, driven
## by a fake clock: no socket, no decoder.

import std/[json, strutils, unittest]

import ../decode_progress

suite "decode progress":
  test "a large body gets a notice before the decode, a small one does not":
    let big = initDecodeProgress("JPEG", 16_738_793, 1200, 1600, 0)
    let note = big.startNote()
    check not note.isNil
    check note["event"].getStr == "image:decode:start"
    check note["bytes"].getInt == 16_738_793
    check note["width"].getInt == 1200
    check note["message"].getStr.startsWith("decoding a 16.0 MB JPEG into 1200x1600")
    let small = initDecodeProgress("JPEG", DecodeNoticeBytes - 1, 1200, 1600, 0)
    check small.startNote().isNil

  test "progress is reported every interval with a percentage and an ETA":
    var progress = initDecodeProgress("JPEG", 1_000_000, 800, 480, 0)
    var step = progress.advance(100_000, 1_000)
    check step.note.isNil
    step = progress.advance(150_000, DecodeProgressIntervalMs)
    check not step.note.isNil
    check step.note["event"].getStr == "image:decode:progress"
    check step.note["bytes"].getInt == 250_000
    check step.note["percent"].getInt == 25
    check step.note["pass"].getInt == 1
    check step.note["elapsedMs"].getInt == DecodeProgressIntervalMs
    # A quarter in 30 s: three quarters more at that rate.
    check step.note["etaMs"].getInt == 3 * DecodeProgressIntervalMs
    step = progress.advance(1, DecodeProgressIntervalMs + 1_000)
    check step.note.isNil

  test "the deadline is renewed on its own, shorter cadence":
    var progress = initDecodeProgress("PNG", 5_000_000, 800, 480, 0)
    check not progress.advance(10, DecodeRenewIntervalMs - 1).renew
    check progress.advance(10, DecodeRenewIntervalMs).renew
    check not progress.advance(10, DecodeRenewIntervalMs + 1).renew
    check progress.advance(10, 2 * DecodeRenewIntervalMs).renew

  test "a rewind starts a new pass and the count over":
    var progress = initDecodeProgress("JPEG", 1_000_000, 800, 480, 0)
    discard progress.advance(900_000, 10_000)
    progress.restart(10_000)
    let step = progress.advance(100_000, 10_000 + DecodeProgressIntervalMs)
    check step.note["pass"].getInt == 2
    check step.note["bytes"].getInt == 100_000
    check step.note["percent"].getInt == 10
    # Elapsed counts from the first pass; the ETA from this one.
    check step.note["elapsedMs"].getInt == 10_000 + DecodeProgressIntervalMs
    check step.note["etaMs"].getInt == 9 * DecodeProgressIntervalMs

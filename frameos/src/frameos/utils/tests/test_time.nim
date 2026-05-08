import std/[math, times, unittest]

import ../time

suite "time helpers":
  test "duration conversions are exact for common values":
    let oneAndHalf = initDuration(milliseconds = 1500)
    check abs(durationToMilliseconds(oneAndHalf) - 1500.0) < 1e-9
    check abs(durationToSeconds(oneAndHalf) - 1.5) < 1e-9

    let twoMinutes = initDuration(minutes = 2)
    check abs(durationToMilliseconds(twoMinutes) - 120000.0) < 1e-9
    check abs(durationToSeconds(twoMinutes) - 120.0) < 1e-9

  test "zero and sub-second durations":
    let zero = initDuration(seconds = 0)
    check durationToMilliseconds(zero) == 0.0
    check durationToSeconds(zero) == 0.0

    let quarter = initDuration(milliseconds = 250)
    check abs(durationToMilliseconds(quarter) - 250.0) < 1e-9
    check abs(durationToSeconds(quarter) - 0.25) < 1e-9

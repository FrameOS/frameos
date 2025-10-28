import times

proc durationToMilliseconds*(value: Duration): float {.inline.} =
  ## Convert a Duration to milliseconds as a floating point value.
  value.inNanoseconds.float / 1_000_000.0

proc durationToSeconds*(value: Duration): float {.inline.} =
  ## Convert a Duration to seconds as a floating point value.
  value.inNanoseconds.float / 1_000_000_000.0

import times, strutils, chrono

# Parse "this/last/next day|week|month|year" into start or end of that period in tz,
# falling back to plain "YYYY-MM-DD" parsing if pattern doesn't match.
proc parsePeriodBoundary*(value, tzName: string; isStart: bool): Timestamp =
  let s = value.strip.toLowerAscii
  if s.len == 0:
    return epochTime().Timestamp

  let parts = s.splitWhitespace
  if parts.len == 2 and (parts[0] in ["this", "last", "next"]) and (parts[1] in ["day", "week", "month", "year"]):
    var cal = calendar(epochTime().Timestamp, tzName)
    let scale = parseTimeScale(parts[1]) # Day/Week/Month/Year
    case parts[0]
    of "last": cal.sub(scale, 1)
    of "next": cal.add(scale, 1)
    else: discard # "this"
    if isStart: cal.toStartOf(scale) else: cal.toEndOf(scale)
    return cal.ts

  return parseTs("{year/4}-{month/2}-{day/2}", value, tzName)

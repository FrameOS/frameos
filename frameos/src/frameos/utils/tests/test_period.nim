import ../period
import times, strutils, chrono

proc expectedTs(modifier, unit, tz: string; isStart: bool): Timestamp =
  var cal = calendar(epochTime().Timestamp, tz)
  let scale = parseTimeScale(unit) # Day|Week|Month|Year
  case modifier
  of "last": cal.sub(scale, 1)
  of "next": cal.add(scale, 1)
  else: discard # "this"
  if isStart: cal.toStartOf(scale) else: cal.toEndOf(scale)
  cal.ts

block test_all_modifiers_periods_start_end:
  let tz = "UTC"
  let modifiers = ["this", "last", "next"]
  let units = ["day", "week", "month", "year"]

  for m in modifiers:
    for u in units:
      # start boundary
      let queryStart = m & " " & u
      let tsStart = parsePeriodBoundary(queryStart, tz, true)
      let expStart = expectedTs(m, u, tz, true)
      doAssert tsStart == expStart, "start mismatch for '" & queryStart & "'"

      # end boundary
      let tsEnd = parsePeriodBoundary(queryStart, tz, false)
      let expEnd = expectedTs(m, u, tz, false)
      doAssert tsEnd == expEnd, "end mismatch for '" & queryStart & "'"

block test_case_and_whitespace_insensitivity:
  let tz = "UTC"
  let q1 = "  Next   Month "
  let q2 = "next month"
  let a = parsePeriodBoundary(q1, tz, true)
  let b = parsePeriodBoundary(q2, tz, true)
  doAssert a == b

block test_specific_examples_match_reference_calculations:
  let tz = "UTC"

  # this day (start)
  var cal1 = calendar(epochTime().Timestamp, tz)
  cal1.toStartOf(Day)
  doAssert parsePeriodBoundary("this day", tz, true) == cal1.ts

  # last week (end)
  var cal2 = calendar(epochTime().Timestamp, tz)
  cal2.sub(Week, 1)
  cal2.toEndOf(Week)
  doAssert parsePeriodBoundary("last week", tz, false) == cal2.ts

  # next year (start)
  var cal3 = calendar(epochTime().Timestamp, tz)
  cal3.add(Year, 1)
  cal3.toStartOf(Year)
  doAssert parsePeriodBoundary("next year", tz, true) == cal3.ts

block test_fallback_plain_date_parsing:
  let tz = "UTC"
  let dateStr = "2025-02-03"
  # parseTs uses the pattern "{year/4}-{month/2}-{day/2}" in period.nim
  let expected = parseTs("{year/4}-{month/2}-{day/2}", dateStr, tz)
  doAssert parsePeriodBoundary(dateStr, tz, true) == expected
  doAssert parsePeriodBoundary(dateStr, tz, false) == expected

# Keep the original two sample cases for completeness/regressions
block test_this_month_regression:
  let tz = "UTC"
  let ts = parsePeriodBoundary("this month", tz, true)
  var cal = calendar(epochTime().Timestamp, tz)
  cal.toStartOf(Month)
  doAssert ts == cal.ts

block test_next_week_regression:
  let tz = "UTC"
  let ts = parsePeriodBoundary("next week", tz, true)
  var cal = calendar(epochTime().Timestamp, tz)
  cal.add(Week, 1)
  cal.toStartOf(Week)
  doAssert ts == cal.ts

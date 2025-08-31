import ../period
import times, chrono

block test_this_month:
  let tz = "UTC"
  let ts = parsePeriodBoundary("this month", tz, true)
  var cal = calendar(epochTime().Timestamp, tz)
  cal.toStartOf(Month)
  doAssert ts == cal.ts

block test_next_week:
  let tz = "UTC"
  let ts = parsePeriodBoundary("next week", tz, true)
  var cal = calendar(epochTime().Timestamp, tz)
  cal.add(Week, 1)
  cal.toStartOf(Week)
  doAssert ts == cal.ts

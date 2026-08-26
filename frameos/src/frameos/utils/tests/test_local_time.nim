import std/[times, unittest]
import lib/tz
import ../local_time

suite "frame local time":
  test "UTC and an empty zone use the process clocks":
    let epoch = dateTime(2026, mAug, 17, 22, 13, 20, zone = utc()).toTime().toUnixFloat()
    check frameLocalTime("UTC", epoch).format("HH:mm:ss") == "22:13:20"
    check frameLocalTime("", epoch).format("HH:mm") == epoch.fromUnixFloat().local().format("HH:mm")

  test "a named zone gives that zone's wall clock":
    initTimeZone()
    # 2026-08-26 12:32:05 UTC = 14:32:05 CEST.
    let epoch = dateTime(2026, mAug, 26, 12, 32, 5, zone = utc()).toTime().toUnixFloat()
    let brussels = frameLocalTime("Europe/Brussels", epoch)
    check brussels.format("HH:mm:ss") == "14:32:05"
    check brussels.format("dddd, d MMMM yyyy") == "Wednesday, 26 August 2026"
    check frameLocalNow("Europe/Brussels").year >= 2026

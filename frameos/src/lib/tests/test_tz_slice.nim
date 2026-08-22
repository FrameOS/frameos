import std/[unittest, json, times]
import chrono
import ../tz

# Europe/Brussels, 2025-2027, as ../tz emits it (dist/zone/Europe/Brussels.json).
const brusselsSlice = """{"timezones":[{"id":1,"name":"Europe/Brussels"}],"dstChanges":[
  {"tzId":1,"name":"CET","start":1729990800,"offset":3600},
  {"tzId":1,"name":"CEST","start":1743296400,"offset":7200},
  {"tzId":1,"name":"CET","start":1761440400,"offset":3600},
  {"tzId":1,"name":"CEST","start":1774746000,"offset":7200},
  {"tzId":1,"name":"CET","start":1792890000,"offset":3600},
  {"tzId":1,"name":"CEST","start":1806195600,"offset":7200},
  {"tzId":1,"name":"CET","start":1824944400,"offset":3600}]}"""

const tokyoSlice = """{"timezones":[{"id":1,"name":"Asia/Tokyo"}],"dstChanges":[
  {"tzId":1,"name":"JST","start":-577962000,"offset":32400}]}"""

const stJohnsSlice = """{"timezones":[{"id":1,"name":"America/St_Johns"}],"dstChanges":[
  {"tzId":1,"name":"NST","start":1730608200,"offset":-12600},
  {"tzId":1,"name":"NDT","start":1741498200,"offset":-9000},
  {"tzId":1,"name":"NST","start":1762057800,"offset":-12600},
  {"tzId":1,"name":"NDT","start":1772947800,"offset":-9000},
  {"tzId":1,"name":"NST","start":1793507400,"offset":-12600}]}"""

suite "per-zone tz slices":
  test "a Brussels slice gives chrono CEST in summer and CET in winter":
    check loadTimeZoneSlice(brusselsSlice)
    var summer = Timestamp(1755820800.0).calendar() # 2025-08-22 00:00 UTC
    summer.applyTimezone("Europe/Brussels")
    check summer.hour == 2
    check summer.dstName == "CEST"
    var winter = Timestamp(1767225600.0).calendar() # 2026-01-01 00:00 UTC
    winter.applyTimezone("Europe/Brussels")
    check winter.hour == 1
    check winter.dstName == "CET"

  test "the POSIX rule for Brussels is the EU rule":
    check loadTimeZoneSlice(brusselsSlice)
    check posixTzRule("Europe/Brussels", 1755820800.0) == "CET-1CEST,M3.5.0,M10.5.0/3"
    # Same rule from inside winter.
    check posixTzRule("Europe/Brussels", 1767225600.0) == "CET-1CEST,M3.5.0,M10.5.0/3"

  test "a zone without DST gives a plain offset rule":
    check loadTimeZoneSlice(tokyoSlice)
    check posixTzRule("Asia/Tokyo", 1755820800.0) == "JST-9"

  test "half-hour zones keep their minutes":
    check loadTimeZoneSlice(stJohnsSlice)
    check posixTzRule("America/St_Johns", 1755820800.0) == "NST3:30NDT,M3.2.0,M11.1.0"

  test "garbage is refused and the previous data stays":
    check loadTimeZoneSlice(brusselsSlice)
    check not loadTimeZoneSlice("<html>")
    check not loadTimeZoneSlice("{\"timezones\":[]}")
    check posixTzRule("Europe/Brussels", 1755820800.0).len > 0
    check posixTzRule("Mars/Olympus", 1755820800.0) == ""

import std/[times, unittest]
import ../../lib/tz
import ../timezone_updater

suite "timezone updater":
  test "daily update is due once at or after scheduled time":
    let early = dateTime(2026, mJun, 2, TimeZoneUpdateHour - 1, 59, 59)
    let due = dateTime(2026, mJun, 2, TimeZoneUpdateHour, TimeZoneUpdateMinute, 0)
    let late = dateTime(2026, mJun, 2, TimeZoneUpdateHour, TimeZoneUpdateMinute + 1, 0)
    let muchLater = dateTime(2026, mJun, 2, 23, 59, 0)

    check shouldRunTimezoneUpdate(early, "") == false
    check shouldRunTimezoneUpdate(due, "") == true
    check shouldRunTimezoneUpdate(due, "2026-06-02") == false
    check shouldRunTimezoneUpdate(late, "") == true
    check shouldRunTimezoneUpdate(muchLater, "") == true
    check shouldRunTimezoneUpdate(muchLater, "2026-06-02") == false

  test "timezone data is fetched from hosted gzip endpoint":
    check TimeZoneDataGzipUrl == "https://tz.frameos.net/tzdata.json.gz"

  test "timezone etag is stored next to downloaded data":
    check timeZoneEtagPath() == "state/tz/tzdata.etag"

  test "sha256 helper matches known digest":
    check sha256Hex("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

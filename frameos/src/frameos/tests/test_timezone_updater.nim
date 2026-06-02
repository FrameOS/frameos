import std/[times, unittest]
import ../../lib/tz
import ../timezone_updater

suite "timezone updater":
  test "daily update is due only once at 3am":
    let due = dateTime(2026, mJun, 2, TimeZoneUpdateHour, TimeZoneUpdateMinute, 0)
    let late = dateTime(2026, mJun, 2, TimeZoneUpdateHour, TimeZoneUpdateMinute + 1, 0)

    check shouldRunTimezoneUpdate(due, "") == true
    check shouldRunTimezoneUpdate(due, "2026-06-02") == false
    check shouldRunTimezoneUpdate(late, "") == false

  test "timezone data is fetched from hosted gzip endpoint":
    check TimeZoneDataGzipUrl == "https://tz.frameos.net/tzdata.json.gz"

  test "timezone etag is stored next to downloaded data":
    check timeZoneEtagPath("/tmp/frameos-assets-test") == "/tmp/frameos-assets-test/.frameos/tz/tzdata.etag"

  test "sha256 helper matches known digest":
    check sha256Hex("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

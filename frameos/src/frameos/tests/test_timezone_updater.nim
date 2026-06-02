import std/[times, unittest]
import ../timezone_updater

suite "timezone updater":
  test "daily update is due only once at 3am":
    let due = dateTime(2026, mJun, 2, TimeZoneUpdateHour, TimeZoneUpdateMinute, 0)
    let late = dateTime(2026, mJun, 2, TimeZoneUpdateHour, TimeZoneUpdateMinute + 1, 0)

    check shouldRunTimezoneUpdate(due, "") == true
    check shouldRunTimezoneUpdate(due, "2026-06-02") == false
    check shouldRunTimezoneUpdate(late, "") == false

  test "manifest parsing validates expected fields":
    let manifest = parseTimeZoneManifest("""{
      "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": 1234,
      "compressedSize": 456,
      "url": "/api/timezones/tzdata.json.gz"
    }""")

    check manifest.sha256 == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    check manifest.size == 1234
    check manifest.compressedSize == 456
    check manifest.url == "/api/timezones/tzdata.json.gz"

  test "relative timezone data urls resolve against the frame server":
    check resolveTimeZoneDataUrl("http://frameos.local:8989", "/api/timezones/tzdata.json.gz") ==
      "http://frameos.local:8989/api/timezones/tzdata.json.gz"
    check resolveTimeZoneDataUrl("http://frameos.local:8989", "api/timezones/tzdata.json.gz") ==
      "http://frameos.local:8989/api/timezones/tzdata.json.gz"
    check resolveTimeZoneDataUrl("http://frameos.local:8989", "https://example.com/tzdata.json.gz") ==
      "https://example.com/tzdata.json.gz"

  test "sha256 helper matches known digest":
    check sha256Hex("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

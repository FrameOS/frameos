import std/[strutils, times, unittest]
import zippy
import ../../lib/tz
import ../types
import ../timezone_updater

suite "timezone updater":
  test "daily update is due once at or after scheduled time":
    let early = dateTime(2026, mJun, 2, 2, 59, 59)
    let due = dateTime(2026, mJun, 2, 3, TimeZoneUpdateMinute, 0)
    let late = dateTime(2026, mJun, 2, 3, TimeZoneUpdateMinute + 1, 0)
    let muchLater = dateTime(2026, mJun, 2, 23, 59, 0)

    check shouldRunTimezoneUpdate(early, "") == false
    check shouldRunTimezoneUpdate(due, "") == true
    check shouldRunTimezoneUpdate(due, "2026-06-02") == false
    check shouldRunTimezoneUpdate(late, "") == true
    check shouldRunTimezoneUpdate(muchLater, "") == true
    check shouldRunTimezoneUpdate(muchLater, "2026-06-02") == false

  test "daily update hour is configurable":
    let beforeCustomHour = dateTime(2026, mJun, 2, 4, 59, 0)
    let atCustomHour = dateTime(2026, mJun, 2, 5, 0, 0)

    check shouldRunTimezoneUpdate(beforeCustomHour, "", 5) == false
    check shouldRunTimezoneUpdate(atCustomHour, "", 5) == true

  test "timezone update config helpers have defaults and clamp invalid hour":
    check timezoneUpdateHour(FrameConfig(timeZoneUpdates: TimeZoneUpdatesConfig(hour: 8))) == 8
    check timezoneUpdateHour(FrameConfig(timeZoneUpdates: TimeZoneUpdatesConfig(hour: 99))) == 3
    check timezoneUpdateUrl(FrameConfig(timeZoneUpdates: TimeZoneUpdatesConfig(url: "https://example.com/tz.gz"))) == "https://example.com/tz.gz"
    check timezoneUpdatesEnabled(FrameConfig(timeZoneUpdates: TimeZoneUpdatesConfig(enabled: false))) == false

  test "timezone data is fetched from hosted gzip endpoint":
    check TimeZoneDataGzipUrl == "https://tz.frameos.net/tzdata.json.gz"

  test "timezone etag is stored next to downloaded data":
    check timeZoneEtagPath() == "state/tz/tzdata.etag"

  test "timezone etag display strips HTTP wrapper quotes":
    check displayTimezoneEtag("\"82c58f73201ad8edbcf337ca3b4f8bb9\"") == "82c58f73201ad8edbcf337ca3b4f8bb9"
    check displayTimezoneEtag("  \"abc123\"  ") == "abc123"
    check displayTimezoneEtag("abc123") == "abc123"

  test "the gzip body is inflated under a cap, not measured afterwards":
    let honest = compress("{\"zones\": []}", dataFormat = dfGzip)
    check boundedGunzip(honest, 1024) == "{\"zones\": []}"
    # An honest archive that is simply too large is refused from its own
    # trailer before a byte is inflated.
    let big = compress("x".repeat(3 * 1024 * 1024), dataFormat = dfGzip)
    check big.len < 64 * 1024
    expect IOError:
      discard boundedGunzip(big, 1024 * 1024)
    # A lying trailer (ISIZE says 16 bytes) is cut off during inflation.
    var lying = big
    lying[^4] = '\x10'
    lying[^3] = '\x00'
    lying[^2] = '\x00'
    lying[^1] = '\x00'
    expect IOError:
      discard boundedGunzip(lying, 1024 * 1024)
    expect IOError:
      discard boundedGunzip("not gzip at all", 1024)

  test "sha256 helper matches known digest":
    check sha256Hex("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

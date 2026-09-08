import std/[json, times, unittest]
import ../types
import ../auto_updater

suite "auto updater":
  test "due once a day at or after the frame's own minute":
    let minute = 37
    let early = dateTime(2026, mSep, 8, AutoUpdateHour, minute - 1, 0)
    let due = dateTime(2026, mSep, 8, AutoUpdateHour, minute, 0)
    let late = dateTime(2026, mSep, 8, 23, 59, 0)

    check shouldRunAutoUpdate(early, "", minute) == false
    check shouldRunAutoUpdate(due, "", minute) == true
    check shouldRunAutoUpdate(due, "2026-09-08", minute) == false
    check shouldRunAutoUpdate(late, "", minute) == true
    check shouldRunAutoUpdate(late, "2026-09-08", minute) == false
    check shouldRunAutoUpdate(late, "2026-09-07", minute) == true

  test "an out-of-range hour or minute falls back to the default slot":
    let atDefault = dateTime(2026, mSep, 8, AutoUpdateHour, 0, 0)
    check shouldRunAutoUpdate(atDefault, "", 99, 99) == true
    check shouldRunAutoUpdate(dateTime(2026, mSep, 8, AutoUpdateHour - 1, 59, 0), "", 99, 99) == false

  test "the minute is stable per frame name and never collides with an on-the-hour reboot":
    check autoUpdateMinute("Kitchen") == autoUpdateMinute("Kitchen")
    check AutoUpdateFirstMinute == 20
    for name in ["", "Kitchen", "Hallway", "frame-42", "a much longer frame name with spaces"]:
      let minute = autoUpdateMinute(name)
      check minute >= AutoUpdateFirstMinute and minute <= 59

  test "only the release build's default scene is allowed to be compiled in":
    check compiledScenesBlockAutoUpdate([]) == false
    check compiledScenesBlockAutoUpdate(["default"]) == false
    check compiledScenesBlockAutoUpdate(["default", "scene_1234"]) == true
    check compiledScenesBlockAutoUpdate(["scene_1234"]) == true

  test "a switched-off frame is skipped before anything is looked up":
    let config = FrameConfig(name: "Kitchen", autoUpdate: "off")
    let line = runAutoUpdateOnce(config)
    check line["status"].getStr() == "skipped"
    check line["reason"].getStr() == "disabled"
    check runAutoUpdateOnce(nil)["reason"].getStr() == "disabled"
    check runAutoUpdateOnce(FrameConfig(name: "x", autoUpdate: ""))["reason"].getStr() == "disabled"

  test "release age reads GitHub's published_at and refuses to guess":
    let now = dateTime(2026, mSep, 9, 12, 0, 0, zone = utc())
    check releaseAgeSeconds("2026-09-08T12:00:00Z", now) == 24 * 60 * 60
    check releaseAgeSeconds("2026-09-09T11:59:00Z", now) == 60
    check releaseAgeSeconds("", now) == -1
    check releaseAgeSeconds("yesterday", now) == -1

  test "stable installs only a release that has been the latest for a day":
    let now = dateTime(2026, mSep, 9, 12, 0, 0, zone = utc())
    check releaseQualifies("stable", "2026-09-08T11:59:59Z", now) == (true, "")
    check releaseQualifies("stable", "2026-09-08T12:00:00Z", now) == (true, "")
    check releaseQualifies("stable", "2026-09-08T12:00:01Z", now) == (false, "waiting_for_stable")
    check releaseQualifies("stable", "2026-09-09T11:00:00Z", now) == (false, "waiting_for_stable")
    check releaseQualifies("stable", "", now) == (false, "publish_time_unknown")
    check releaseQualifies("stable", "not a date", now) == (false, "publish_time_unknown")

  test "latest installs every release as soon as it is published, off never":
    let now = dateTime(2026, mSep, 9, 12, 0, 0, zone = utc())
    check releaseQualifies("latest", "2026-09-09T11:59:59Z", now) == (true, "")
    check releaseQualifies("latest", "", now) == (true, "")
    check releaseQualifies("off", "2026-09-01T00:00:00Z", now) == (false, "disabled")
    check releaseQualifies("", "2026-09-01T00:00:00Z", now) == (false, "disabled")

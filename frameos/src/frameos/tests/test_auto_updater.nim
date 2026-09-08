import std/[json, times, unittest]
import ../types
import ../auto_updater

suite "auto updater":
  test "due once a day at or after the frame's own minute":
    let minute = 17
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

  test "the minute is stable per frame name and always a minute":
    check autoUpdateMinute("Kitchen") == autoUpdateMinute("Kitchen")
    for name in ["", "Kitchen", "Hallway", "frame-42", "a much longer frame name with spaces"]:
      let minute = autoUpdateMinute(name)
      check minute >= 0 and minute <= 59

  test "only the release build's default scene is allowed to be compiled in":
    check compiledScenesBlockAutoUpdate([]) == false
    check compiledScenesBlockAutoUpdate(["default"]) == false
    check compiledScenesBlockAutoUpdate(["default", "scene_1234"]) == true
    check compiledScenesBlockAutoUpdate(["scene_1234"]) == true

  test "a switched-off frame is skipped before anything is looked up":
    let config = FrameConfig(name: "Kitchen", autoUpdate: false)
    let line = runAutoUpdateOnce(config)
    check line["status"].getStr() == "skipped"
    check line["reason"].getStr() == "disabled"
    check runAutoUpdateOnce(nil)["reason"].getStr() == "disabled"

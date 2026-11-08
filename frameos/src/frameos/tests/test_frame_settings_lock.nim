import std/[os, unittest]
import ../types
import ../config
import ../frame_settings_lock

suite "the frame page of the settings on the screen":
  let dir = getTempDir() / "frameos-settings-lock-test"
  createDir(dir)
  let unlock = dir / "frameos-settings-unlock"
  setSettingsUnlockPathsForTest(@[dir / "absent", unlock])

  teardown:
    removeFile(unlock)

  test "on unless frame.json turns it off":
    check parseFrameConfig("{}").frameSettingsOnScreen
    check framePageOffered(parseFrameConfig("{}"))
    check framePageOffered(parseFrameConfig("""{"frameSettingsOnScreen": true}"""))
    check not framePageOffered(parseFrameConfig("""{"frameSettingsOnScreen": false}"""))

  test "the unlock file on the boot partition wins over off, for as long as it is there":
    let off = parseFrameConfig("""{"frameSettingsOnScreen": false}""")
    writeFile(unlock, "")
    check settingsUnlocked()
    check framePageOffered(off)
    removeFile(unlock)
    check not framePageOffered(off)

  test "no config is the unlock alone":
    check not framePageOffered(nil)
    writeFile(unlock, "")
    check framePageOffered(nil)

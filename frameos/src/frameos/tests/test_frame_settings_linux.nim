import std/[json, options, os, strutils, unittest]
import frameos/channels
import frameos/config
import frameos/types
import frameos/events_gen
import frameos/frame_settings_lock
import frameos/frame_settings_linux

# The settings panel's frame page on a Linux frame (docs/scene-settings.md
# "The frame page"): what the host hands the page, the plane's switch and the
# boot partition's unlock, and what Save does with the rotation and the scale.
# Wi-Fi runs the portal's commands on a thread of its own and is not started
# here: nothing below asks for a scan or a join.

let dir = getTempDir() / "frameos-frame-settings-linux-test"
removeDir(dir)
createDir(dir)
let configPath = dir / "frame.json"
let unlockPath = dir / "frameos-settings-unlock"
putEnv("FRAMEOS_CONFIG", configPath)
setSettingsUnlockPathsForTest(@[unlockPath])

var sent: seq[(string, EventOrigin)]
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    sent.add((event, origin))

proc writeConfig(onScreen: bool) =
  writeFile(configPath, $(%*{"name": "Test", "mode": "rpios", "device": "web_only", "width": 800,
    "height": 480, "rotate": 0, "renderScale": 0, "frameSettingsOnScreen": onScreen}))
  noteFrameConfigChanged()

proc logged(event: string): seq[JsonNode] =
  while true:
    let (ok, line) = logChannel.tryRecv()
    if not ok:
      break
    if line.event == event:
      result.add parseJson(line.line)

suite "the frame page on a Linux frame":
  test "the page's facts: rotation, scale, Restart FrameOS, no password held":
    writeConfig(true)
    let facts = linuxFrameSettingsRead()
    check not facts.isNil
    check facts["rotate"].getInt(-1) == 0
    check facts["renderScale"].getFloat(-1) == 0
    check facts["actions"] == %*["restart"]
    check facts["version"].getStr().len > 0
    # Before the worker has read anything there is a Wi-Fi block to fill.
    check facts["wifi"]["password"].getBool(true) == false
    check facts["wifi"]["networks"].len == 0

  test "the plane turns it off, and the boot partition's file turns it on again":
    writeConfig(false)
    check linuxFrameSettingsRead().isNil
    writeFile(unlockPath, "")
    check not linuxFrameSettingsRead().isNil
    removeFile(unlockPath)
    check linuxFrameSettingsRead().isNil
    writeConfig(true)
    check not linuxFrameSettingsRead().isNil

  test "Save sets the scale and the rotation in frame.json, says so, and reloads":
    writeConfig(true)
    discard logged("settings:frame")
    sent.setLen(0)
    linuxFrameSettingsApply(%*{"renderScale": 1.5, "rotate": 90})
    let saved = parseFile(configPath)
    check saved["renderScale"].getFloat() == 1.5
    check saved["rotate"].getInt() == 90
    let lines = logged("settings:frame")
    check lines.len == 1
    check lines[0]["origin"].getStr() == "panel"
    check lines[0]["rotate"].getInt() == 90
    check lines[0]["renderScale"].getFloat() == 1.5
    check "wifi" notin $lines[0]
    check sent.len == 1
    check sent[0][0] in [evReload, evRestart] and sent[0][1] == eoSystem

  test "a value as it is changes nothing":
    sent.setLen(0)
    discard logged("settings:frame")
    linuxFrameSettingsApply(%*{"renderScale": 1.5})
    check logged("settings:frame").len == 0
    check sent.len == 0

  test "nonsense is not saved":
    linuxFrameSettingsApply(%*{"rotate": 45, "renderScale": 9})
    let saved = parseFile(configPath)
    check saved["rotate"].getInt() == 90
    check saved["renderScale"].getFloat() == 1.5

removeDir(dir)

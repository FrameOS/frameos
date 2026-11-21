import std/[json, options, os, strutils, unittest]
import frameos/channels
import frameos/config
import frameos/types
import frameos/events_gen
import frameos/frame_settings_lock
import frameos/frame_settings_linux
import frameos/local_access
import frameos/cloud/link_state

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
# The cloud link's files (./state/cloud_link.json and its siblings) land here,
# not in the checkout.
putEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH", dir / "state" / "cloud_link_code_pending.json")
putEnv("FRAMEOS_CLOUD_ENROLL_PENDING_PATH", dir / "state" / "cloud_enroll_pending.json")
setCurrentDir(dir)
setSettingsUnlockPathsForTest(@[unlockPath])

var sent: seq[(string, EventOrigin)]
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    sent.add((event, origin))

proc writeConfig(onScreen: bool, device = "web_only", serverHost = "", serverApiKey = "") =
  writeFile(configPath, $(%*{"name": "Test", "mode": "rpios", "device": device, "width": 800,
    "height": 480, "rotate": 0, "renderScale": 0, "frameSettingsOnScreen": onScreen,
    "serverHost": serverHost, "serverApiKey": serverApiKey, "framePort": 8787}))
  noteFrameConfigChanged()

proc actions(): JsonNode =
  linuxFrameSettingsRead()["actions"]

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
    # No control plane holds it, but it has no panel to show a code on: no
    # plane is offered.
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

  test "the scale alone is set in the live config and drawn, with no reload":
    let live = FrameConfig(renderScale: 1.5)
    setLiveConfigForTest(live)
    discard logged("settings:frame")
    sent.setLen(0)
    linuxFrameSettingsApply(%*{"renderScale": 0.75})
    check parseFile(configPath)["renderScale"].getFloat() == 0.75
    check live.renderScale == 0.75
    check sent.len == 1 and sent[0][0] == evRender
    check logged("settings:frame").len == 1
    # Back as it was for the tests below.
    linuxFrameSettingsApply(%*{"renderScale": 1.5})
    setLiveConfigForTest(nil)

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

  test "a frame no plane holds offers both planes, with a panel to show the code on":
    writeConfig(true, device = "waveshare.EPD_7in5_V2")
    check actions() == %*["restart", "linkCloud", "adopt"]
    # Waiting for a backend (the portal's "backend" mode): the cloud refuses
    # to enroll it, a backend's adoption still takes it.
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "10.0.0.5")
    check actions() == %*["restart", "adopt"]
    # A backend holds it: neither.
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "10.0.0.5", serverApiKey = "k")
    check actions() == %*["restart"]

  test "a backend's code: on the frame page, with the address and what the QR code says":
    writeConfig(true, device = "waveshare.EPD_7in5_V2")
    sent.setLen(0)
    linuxFrameSettingsAction("adopt")
    check pendingLocalAccessScope() == LocalAccessScopeAdopt
    let code = activeLocalAccessCode()
    check code.len == 6
    # The page draws it, never the runner's overlay.
    check localAccessPanelText() == ""
    let link = linuxFrameSettingsRead()["link"]
    check link["to"].getStr() == "backend"
    check link["code"].getStr() == code
    check link["where"].getStr().endsWith(":8787")
    check link["qr"].getStr() == link["where"].getStr() & " " & code
    # While it shows, nothing else to start; Cancel takes it off.
    check actions() == %*["restart"]
    check sent.len == 1 and sent[0][0] == evRender
    linuxFrameSettingsAction("cancelLink")
    check pendingLocalAccessScope() == ""
    check linuxFrameSettingsRead(){"link"}.isNil

  test "Cancel never ends a local network access code":
    writeConfig(true, device = "waveshare.EPD_7in5_V2")
    discard startLocalAccessChallenge(LocalAccessScopeLocalNetwork)
    linuxFrameSettingsAction("cancelLink")
    check pendingLocalAccessScope() == LocalAccessScopeLocalNetwork
    clearLocalAccessChallenge()

  test "the cloud: a link code queued for the hub thread, one plane at a time, and Cancel drops it":
    writeConfig(true, device = "waveshare.EPD_7in5_V2")
    linuxFrameSettingsAction("adopt")
    linuxFrameSettingsAction("linkCloud")
    # Asking for the cloud ended the backend's code.
    check pendingLocalAccessScope() == ""
    let pending = parseFile(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    check pending["provider_url"].getStr() == DEFAULT_CLOUD_PROVIDER_URL
    let facts = linuxFrameSettingsRead()
    # No code until the provider gave one; the page says a link is under way.
    check facts["link"]["to"].getStr() == "cloud"
    check facts["link"]["code"].getStr() == ""
    check facts["actions"] == %*["restart"]
    linuxFrameSettingsAction("cancelLink")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    check linuxFrameSettingsRead(){"link"}.isNil

  test "a frame that is only a picture, or waits for a backend, is not offered the cloud":
    writeConfig(true)
    check actions() == %*["restart"]
    linuxFrameSettingsAction("linkCloud")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "10.0.0.5")
    linuxFrameSettingsAction("linkCloud")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))

removeDir(dir)

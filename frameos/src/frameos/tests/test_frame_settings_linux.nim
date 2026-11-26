import std/[json, locks, options, os, strutils, unittest]
import frameos/channels
import frameos/config
import frameos/types
import frameos/events_gen
import frameos/frame_settings_lock
import frameos/frame_settings_linux
import frameos/local_access
import frameos/cloud/link_state
import frameos/about_linux
from frameos/utils/system import setSystemHostnameForTest

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
  test "service keys typed on the frame: under state/, for the frame's user alone":
    # docs/scene-settings.md "Service keys": no deploy rewrites state/.
    removeFile(ServiceKeysPath)
    check linuxServiceKeysLoad() == ""
    check linuxServiceKeysSave("""{"openAI":{"apiKey":"sk-1"}}""")
    check linuxServiceKeysLoad() == """{"openAI":{"apiKey":"sk-1"}}"""
    check getFilePermissions(ServiceKeysPath) == {fpUserRead, fpUserWrite}
    check linuxServiceKeysSave("{}")
    check linuxServiceKeysLoad() == "{}"

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
    # A backend holds it: neither, and Unlink.
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "10.0.0.5", serverApiKey = "k")
    check actions() == %*["restart", "unlink"]

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
    # Where it goes, shown on the page and changed there: the queued link
    # starts over against the new address, and the next link goes there too.
    check facts["link"]["server"].getStr() == DEFAULT_CLOUD_PROVIDER_URL
    linuxFrameSettingsApply(%*{"cloudUrl": "frames.example.org/"})
    check parseFile(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))["provider_url"].getStr() ==
      "https://frames.example.org"
    check linuxFrameSettingsRead()["link"]["server"].getStr() == "https://frames.example.org"
    # Plain http to a host on the internet is refused, and the page says why.
    linuxFrameSettingsApply(%*{"cloudUrl": "http://frames.example.org"})
    check linuxFrameSettingsRead()["note"].getStr().len > 0
    check linuxFrameSettingsRead()["link"]["server"].getStr() == "https://frames.example.org"
    # A link that stopped says why until Try again or Cancel.
    let stopped = parseFile(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    stopped["failed"] = %"reach"
    stopped["detail"] = %"HTTP 404"
    stopped["stopped"] = %true
    writeFile(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"), $stopped)
    check linuxFrameSettingsRead()["link"]["failed"].getStr() == "reach"
    linuxFrameSettingsAction("linkCloud")
    check linuxFrameSettingsRead()["link"]{"failed"}.isNil
    linuxFrameSettingsApply(%*{"cloudUrl": ""})
    check linuxFrameSettingsRead()["link"]["server"].getStr() == DEFAULT_CLOUD_PROVIDER_URL
    linuxFrameSettingsAction("cancelLink")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    check linuxFrameSettingsRead(){"link"}.isNil
    # Leaving the page, however, ends either code: it lives only while its
    # page is up.
    linuxFrameSettingsAction("linkCloud")
    check fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    linuxFrameSettingsAction("close")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    linuxFrameSettingsAction("adopt")
    check pendingLocalAccessScope() == LocalAccessScopeAdopt
    linuxFrameSettingsAction("close")
    check pendingLocalAccessScope() == ""
    check linuxFrameSettingsRead(){"link"}.isNil

  test "Unlink leaves the plane that manages the frame, a backend's or the cloud's":
    # A backend: the frame forgets its address (the Save that clears the
    # server, which tells the backend it left) and restarts.
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "127.0.0.1", serverApiKey = "key")
    check %"unlink" in actions().elems
    check %"adopt" notin actions().elems
    linuxFrameSettingsAction("unlink")
    for _ in 0 ..< 200:
      if parseFile(configPath){"serverHost"}.getStr("x") == "":
        break
      sleep(20)
    check parseFile(configPath){"serverHost"}.getStr("x") == ""
    noteFrameConfigChanged()
    check %"unlink" notin actions().elems
    # The cloud: its link is reset (the cloud is told first where it can be
    # reached; here it cannot, and the frame leaves all the same).
    writeConfig(true, device = "waveshare.EPD_7in5_V2")
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["status"] = %"connected"
      state["provider_url"] = %"http://127.0.0.1:1"
      state["access_token"] = %"token"
      saveCloudLinkState(state)
    check %"unlink" in actions().elems
    linuxFrameSettingsAction("unlink")
    var status = "connected"
    for _ in 0 ..< 200:
      withLock cloudLinkLock:
        status = loadCloudLinkState(){"status"}.getStr("disconnected")
      if status != "connected":
        break
      sleep(20)
    check status != "connected"
    check %"unlink" notin actions().elems
    check %"linkCloud" in actions().elems

  test "a frame that is only a picture, or waits for a backend, is not offered the cloud":
    writeConfig(true)
    check actions() == %*["restart"]
    linuxFrameSettingsAction("linkCloud")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "10.0.0.5")
    linuxFrameSettingsAction("linkCloud")
    check not fileExists(getEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH"))

  test "About: what the frame is, read off /proc, /sys and /etc, and the plane's address":
    # docs/scene-settings.md "About": numbers as they are, bytes as bytes,
    # [total, free] for what fills; a fact the system does not say is left out.
    let root = dir / "root"
    for (path, text) in [("/proc/device-tree/model", "Raspberry Pi 4 Model B Rev 1.4\0"),
        ("/proc/device-tree/compatible", "raspberrypi,4-model-b\0brcm,bcm2711\0"),
        ("/proc/meminfo", "MemTotal:        3884024 kB\nMemFree:          912344 kB\nMemAvailable:    3038372 kB\n"),
        ("/proc/uptime", "273900.52 1083260.11\n"),
        ("/etc/os-release", "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nID=debian\n"),
        ("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "1500000\n"),
        ("/sys/class/net/eth0/address", "dc:a6:32:01:02:03\n"),
        ("/sys/class/net/wlan0/address", "dc:a6:32:0a:0b:0c\n")]:
      createDir(parentDir(root & path))
      writeFile(root & path, text)
    aboutRoot = root
    aboutMachineForTest = "aarch64"
    setSystemHostnameForTest("kitchen")
    var facts = linuxAboutFacts("wlan0", dir)
    check facts["chip"] == %"aarch64"
    check facts["soc"] == %"bcm2711"
    check facts["cores"].getInt() >= 1
    check facts["mhz"] == %1500
    check facts["board"] == %"Raspberry Pi 4 Model B Rev 1.4"
    check facts["system"] == %"Debian GNU/Linux 12 (bookworm)"
    check facts["memory"] == %*[3884024 * 1024, 3038372 * 1024]
    check facts["uptime"] == %273900
    check facts["mac"] == %"dc:a6:32:0a:0b:0c"
    check facts["hostname"] == %"kitchen"
    check facts["storage"].len == 2 and facts["storage"][0].getBiggestInt() >= facts["storage"][1].getBiggestInt()
    # No Wi-Fi device known: wlan0's, and without one the wired one. A system
    # that says less, less.
    check linuxAboutFacts("", dir)["mac"] == %"dc:a6:32:0a:0b:0c"
    removeFile(root & "/sys/class/net/wlan0/address")
    check linuxAboutFacts("", dir)["mac"] == %"dc:a6:32:01:02:03"
    removeFile(root & "/proc/device-tree/model")
    removeFile(root & "/proc/device-tree/compatible")
    removeFile(root & "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
    facts = linuxAboutFacts("wlan0", dir / "missing")
    check not facts.hasKey("board") and not facts.hasKey("soc") and not facts.hasKey("mhz")
    check not facts.hasKey("storage")
    # On the page, with where the backend that manages the frame is.
    writeConfig(true, device = "waveshare.EPD_7in5_V2", serverHost = "10.0.0.5", serverApiKey = "k")
    let about = linuxFrameSettingsRead()["about"]
    check about["chip"] == %"aarch64"
    check about["server"].getStr().startsWith("http://10.0.0.5:")
    writeConfig(true)
    check not linuxFrameSettingsRead()["about"].hasKey("server")
    aboutRoot = ""
    aboutMachineForTest = ""
    setSystemHostnameForTest("")

  test "Brightness: a backlight with levels, set as it moves and kept when the finger lifts":
    let root = dir / "sysroot-backlight"
    createDir(root / "sys/class/backlight/gpio")
    writeFile(root / "sys/class/backlight/gpio/max_brightness", "1\n")
    writeFile(root / "sys/class/backlight/gpio/brightness", "1\n")
    aboutRoot = root
    writeConfig(true)
    brightnessPath = dir / "state-brightness"
    # A HyperPixel's GPIO backlight is on or off: no brightness offered.
    check backlightPercent() == -1
    check not linuxFrameSettingsRead().hasKey("brightness")
    linuxFrameSettingsApply(%*{"brightness": 50})
    check readFile(root / "sys/class/backlight/gpio/brightness") == "1\n"
    check not fileExists(brightnessPath)
    # One with levels (the official touch display's, 0..255).
    createDir(root / "sys/class/backlight/rpi")
    writeFile(root / "sys/class/backlight/rpi/max_brightness", "255\n")
    writeFile(root / "sys/class/backlight/rpi/brightness", "128\n")
    check linuxFrameSettingsRead()["brightness"] == %50
    # While a finger drags it: set, not kept.
    linuxFrameSettingsApply(%*{"brightness": 70, "live": true})
    check readFile(root / "sys/class/backlight/rpi/brightness") == "179"
    check linuxFrameSettingsRead()["brightness"] == %70
    check not fileExists(brightnessPath)
    # It lifts: kept, and never quite dark.
    linuxFrameSettingsApply(%*{"brightness": 5})
    check readFile(root / "sys/class/backlight/rpi/brightness") == "13"
    check readFile(brightnessPath) == "5"
    aboutRoot = ""

removeDir(dir)

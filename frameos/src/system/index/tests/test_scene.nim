import std/[os, json, algorithm, strutils, times, sequtils, unittest]
import pixie
import lib/tz
import ../../../frameos/types
import ../../../frameos/network_state
from ../../../frameos/utils/system import setSystemHostnameForTest
import ../scene as index_scene

proc testConfig(): FrameConfig =
  FrameConfig(
    name: "Kitchen Frame",
    mode: "frame",
    serverHost: "frameos.local",
    serverPort: 8989,
    frameHost: "192.168.1.50",
    framePort: 8787,
    width: 800,
    height: 480,
    device: "waveshare",
    rotate: 90,
    scalingMode: "contain",
    debug: true,
    timeZone: "Europe/Brussels",
    frameAccess: "public",
    frameAccessKey: "",
    frameAdminAuth: %*{},
    saveAssets: %*false,
    httpsProxy: HttpsProxyConfig(enable: false, port: 0, exposeOnlyPort: false),
    agent: AgentConfig(agentEnabled: false)
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    discard payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc makeIndexScene(config: FrameConfig): index_scene.Scene =
  index_scene.Scene(index_scene.init("system/index".SceneId, config, testLogger(config), %*{}))

proc withScenesJson(content: string, body: proc(path: string)) =
  let tempPath = getTempDir() / ("frameos-index-scene-" & $epochTime() & ".json")
  let hadEnv = existsEnv("FRAMEOS_SCENES_JSON")
  let previous = if hadEnv: getEnv("FRAMEOS_SCENES_JSON") else: ""
  writeFile(tempPath, content)
  putEnv("FRAMEOS_SCENES_JSON", tempPath)
  try:
    body(tempPath)
  finally:
    if fileExists(tempPath):
      removeFile(tempPath)
    if hadEnv:
      putEnv("FRAMEOS_SCENES_JSON", previous)
    else:
      delEnv("FRAMEOS_SCENES_JSON")

suite "system/index scene":
  test "scene list includes compiled and interpreted scenes with stable ordering":
    withScenesJson("""[
      {"id": "default", "name": "Should Not Replace Compiled Name"},
      {"id": "interpreted/weather", "name": "Weather"},
      {"id": "interpreted/no-name"}
    ]""") do (_: string):
      let entries = makeIndexScene(testConfig()).buildSceneList()
      check entries.anyIt(it[0] == "default" and it[1] == "Default Scene")
      check entries.anyIt(it[0] == "interpreted/weather" and it[1] == "Weather")
      check entries.anyIt(it[0] == "interpreted/no-name" and it[1] == "interpreted/no-name")
      check not entries.anyIt(it[0].startsWith("system/"))

      var names = entries.mapIt(it[1])
      var sortedNames = names
      sortedNames.sort(proc(a, b: string): int = cmpIgnoreCase(a, b))
      check names == sortedNames

  test "scene text output includes expected device metadata and numbered list":
    withScenesJson("[]") do (_: string):
      let text = makeIndexScene(testConfig()).buildSceneListText()
      check text.startsWith("FrameOS\n")
      check "Name: Kitchen Frame" in text
      check "Device: waveshare · 800×480 · rotated 90°" in text
      check "Time zone: Europe/Brussels" in text
      check "Time: " in text
      check "Network: " in text
      check "Internet: not checked" in text
      check "Managed via: self-hosted backend (http://frameos.local:8989)" in text
      check "Frame: http://192.168.1.50:8787" in text
      check "Remote control: disabled" in text
      check "Installed scenes" in text
      check "1. Default Scene" in text

  test "the internet row follows the last connectivity check":
    withScenesJson("[]") do (_: string):
      noteNetworkCheck(NetworkStatus.connected)
      check "Internet: connected" in makeIndexScene(testConfig()).buildSceneListText()
      noteNetworkCheck(NetworkStatus.timeout, "check timed out after 30 s")
      check "Internet: no internet — check timed out after 30 s" in makeIndexScene(testConfig()).buildSceneListText()
      noteNetworkCheck(NetworkStatus.error, "x".repeat(200))
      let text = makeIndexScene(testConfig()).buildSceneListText()
      check "Internet: no internet — " & "x".repeat(71) & "…" in text
      resetNetworkCheckForTest()
      check "Internet: not checked" in makeIndexScene(testConfig()).buildSceneListText()

  test "the scene paints the status screen onto the render canvas":
    withScenesJson("[]") do (_: string):
      let scene = makeIndexScene(testConfig())
      let image = newImage(400, 240)
      let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
        image: image, hasImage: true, loopIndex: 0, loopKey: ".")
      discard index_scene.render(scene, context)
      # Black background with white text: the canvas is no longer all one colour.
      var white = 0
      var black = 0
      for y in 0 ..< image.height:
        for x in 0 ..< image.width:
          let px = image[x, y]
          if px.r > 200 and px.g > 200 and px.b > 200: inc white
          elif px.r < 30 and px.g < 30 and px.b < 30: inc black
      check white > 100
      check black > white

  test "management line prefers the cloud link and falls back to standalone":
    # loadCloudLinkState reads ./state/cloud_link.json relative to the cwd, so
    # run this from a scratch directory we control.
    let previousDir = getCurrentDir()
    let tempDir = getTempDir() / ("frameos-index-scene-link-" & $epochTime())
    createDir(tempDir / "state")
    setCurrentDir(tempDir)
    try:
      var config = testConfig()
      config.serverHost = ""
      check index_scene.managementLine(config) == "Managed via: standalone (no server configured)"

      config.serverHost = "localhost"
      check index_scene.managementLine(config) == "Managed via: standalone (no server configured)"

      writeFile("state" / "cloud_link.json", $(%*{
        "mode": "managed",
        "status": "connected",
        "provider_url": "https://cloud.frameos.net",
      }))
      check index_scene.managementLine(config) ==
        "Managed via: FrameOS Cloud (cloud.frameos.net, connected)"
    finally:
      setCurrentDir(previousDir)
      removeDir(tempDir)

  test "remote control security line names the transport honestly":
    let previousDir = getCurrentDir()
    let tempDir = getTempDir() / ("frameos-index-scene-security-" & $epochTime())
    createDir(tempDir / "state")
    setCurrentDir(tempDir)
    try:
      var config = testConfig()

      # Remote control off, no cloud link: nothing to say.
      check index_scene.remoteControlSecurityLine(config) == ""

      # Self-hosted agent: TLS iff the port says so (the agent's dial rule).
      config.agent = AgentConfig(agentEnabled: true)
      config.serverPort = 8989
      check "UNENCRYPTED" in index_scene.remoteControlSecurityLine(config)
      check "frameos.local:8989" in index_scene.remoteControlSecurityLine(config)
      config.serverPort = 8443
      check "encrypted TLS" in index_scene.remoteControlSecurityLine(config)

      # Cloud-managed wins over the agent flag and reports the provider link.
      writeFile("state" / "cloud_link.json", $(%*{
        "mode": "managed",
        "status": "connected",
        "provider_url": "https://cloud.frameos.net",
      }))
      check "encrypted HTTPS connection to cloud.frameos.net" in
        index_scene.remoteControlSecurityLine(config)

      writeFile("state" / "cloud_link.json", $(%*{
        "mode": "managed",
        "status": "connected",
        "provider_url": "http://10.4.0.47:4999",
      }))
      check "UNENCRYPTED http" in index_scene.remoteControlSecurityLine(config)
    finally:
      setCurrentDir(previousDir)
      removeDir(tempDir)

  test "the clock row shows the frame's local time, with seconds only when animating":
    initTimeZone()
    # 2026-08-26 12:32:05 UTC = 14:32:05 CEST.
    let epoch = dateTime(2026, mAug, 26, 12, 32, 5, zone = utc()).toTime().toUnixFloat()
    withScenesJson("[]") do (_: string):
      var config = testConfig()
      let eink = makeIndexScene(config).buildStatusScreen(epoch)
      check eink.rows.anyIt(it[0] == "Time" and it[1] == "14:32 · Wednesday, 26 August 2026")
      check eink.rows.anyIt(it[0] == "Time zone" and it[1] == "Europe/Brussels")
      check eink.markPhase == 0.0

      config.device = "framebuffer"
      let hdmi = makeIndexScene(config).buildStatusScreen(epoch)
      check hdmi.rows.anyIt(it[0] == "Time" and it[1] == "14:32:05 · Wednesday, 26 August 2026")
      check hdmi.markPhase > 0.0 and hdmi.markPhase <= 1.0

  test "a GPIO button press lands in the bottom bar and asks for a redraw":
    initTimeZone()
    withScenesJson("[]") do (_: string):
      let scene = makeIndexScene(testConfig())
      check scene.lastButtonLine() == ""
      check scene.buildStatusScreen().bar == ""
      let context = ExecutionContext(scene: scene, event: "button",
        payload: %*{"pin": 5, "label": "Next", "level": 0}, hasImage: false, loopIndex: 0, loopKey: ".")
      index_scene.runEvent(scene, context)
      let line = scene.lastButtonLine()
      check line.startsWith("Last button: Next (GPIO 5) at ")
      check scene.buildStatusScreen().bar == line
      check line in scene.buildSceneListText()
      # An unlabelled pin still says which one.
      index_scene.runEvent(scene, ExecutionContext(scene: scene, event: "button",
        payload: %*{"pin": 27}, hasImage: false, loopIndex: 0, loopKey: "."))
      check scene.lastButtonLine().startsWith("Last button: button (GPIO 27) at ")

  test "the scene list is rebuilt when the scenes file changes, not on every frame":
    initTimeZone()
    withScenesJson("""[{"id": "one", "name": "Scene One"}]""") do (path: string):
      let scene = makeIndexScene(testConfig())
      check scene.buildSceneList(100.0).anyIt(it[1] == "Scene One")
      # Rewritten to the same size and stamped back to the same mtime: the
      # cache cannot see it, and that is the point — a screen redrawing once
      # a second does not inflate and parse this file once a second.
      let stamp = getLastModificationTime(path)
      writeFile(path, """[{"id": "two", "name": "Scene Two"}]""")
      setLastModificationTime(path, stamp)
      check scene.buildSceneList(100.5).anyIt(it[1] == "Scene One")
      check not scene.buildSceneList(100.5).anyIt(it[1] == "Scene Two")
      # A real deploy moves the mtime, and the very next frame shows the list.
      setLastModificationTime(path, stamp + initDuration(seconds = 5))
      check scene.buildSceneList(100.6).anyIt(it[1] == "Scene Two")

  test "the network and cloud rows are re-read on a timer, not on every frame":
    initTimeZone()
    withScenesJson("[]") do (_: string):
      var config = testConfig()
      # `frame.local` is the image default, so the row shows the name the
      # system actually carries — which is what we can steer from a test.
      config.frameHost = "frame.local"
      let scene = makeIndexScene(config)
      setSystemHostnameForTest("alpha")
      check scene.buildStatusScreen(1000.0).rows.anyIt(
        it[0] == "Frame" and "alpha.local" in it[1])
      # Within the window the screen keeps what it has: no socket, no
      # /etc/hostname, no /proc/net/route, no cloud_link.json for this frame.
      setSystemHostnameForTest("beta")
      check scene.buildStatusScreen(1005.0).rows.anyIt(
        it[0] == "Frame" and "alpha.local" in it[1])
      # Past it, the facts are read again.
      check scene.buildStatusScreen(1020.0).rows.anyIt(
        it[0] == "Frame" and "beta.local" in it[1])
      # A clock that steps backwards (NTP settling after boot) also expires it.
      setSystemHostnameForTest("gamma")
      check scene.buildStatusScreen(900.0).rows.anyIt(
        it[0] == "Frame" and "gamma.local" in it[1])
      setSystemHostnameForTest("")

  test "the inputs row lists the input drivers in the build":
    var config = testConfig()
    # No input driver in the build: the row is dropped entirely (see "the
    # inputs and buttons rows are absent when nothing can drive the frame").
    check index_scene.inputsLine(config, @[]) == ""
    check index_scene.inputsLine(config, @["evdev"]) == "evdev (keyboard, mouse, touch)"
    # The buttons have their own row, wired or not: the gpioButton driver
    # adds nothing here.
    config.gpioButtons = @[GPIOButton(pin: 5, label: "Next")]
    check index_scene.inputsLine(config, @["gpioButton"]) == ""
    check index_scene.inputsLine(config, @["gpioButton", "evdev"]) == "evdev (keyboard, mouse, touch)"
    # An input driver we have no wording for is still named, never dropped.
    check index_scene.inputsLine(config, @["evdev", "someNewInput"]) ==
      "evdev (keyboard, mouse, touch) · someNewInput"

  test "the buttons row lists the wired buttons by label and pin":
    var config = testConfig()
    check index_scene.buttonsLine(config) == ""
    config.gpioButtons = @[
      GPIOButton(pin: 5, label: "Next"),
      GPIOButton(pin: 6, label: ""),
      GPIOButton(pin: -1, label: "Unwired"),
    ]
    # No event map: every press is the scene's, so there is nothing to add.
    check index_scene.buttonsLine(config) == "Next (GPIO 5) · GPIO 6"
    config.eventMap = %*[]
    check index_scene.buttonsLine(config) == "Next (GPIO 5) · GPIO 6"

  test "the buttons row says what the frame's event map does with each press":
    var config = testConfig()
    config.gpioButtons = @[
      GPIOButton(pin: 5, label: "LEFT"),
      GPIOButton(pin: 4, label: "RIGHT"),
      GPIOButton(pin: 3, label: "REFRESH"),
    ]
    # The reTerminal E1002 preset (fos_board.c, EMBEDDED_HARDWARE_PRESETS).
    config.eventMap = %*[
      {"event": "button", "match": {"label": "LEFT", "action": "longPress"},
       "emit": "setCurrentScene", "as": {"direction": "prev"}},
      {"event": "button", "match": {"label": "RIGHT", "action": "longPress"},
       "emit": "setCurrentScene", "as": {"direction": "next"}},
      {"event": "button", "match": {"label": "REFRESH", "action": "longPress"},
       "emit": "voiceChat", "as": {}},
    ]
    check index_scene.buttonsLine(config) ==
      "LEFT (GPIO 5) long press: previous scene · RIGHT (GPIO 4) long press: next scene · " &
      "REFRESH (GPIO 3) long press: voice chat"

    let scenes = @[("weather", "Weather")]
    config.eventMap = %*[
      # A rewrite hands the press on to the scene: not a frame action, and
      # being first it wins over the rule after it, as on the dispatcher.
      {"event": "button", "match": {"label": "LEFT", "action": "press"}, "as": {"label": "A"}},
      {"event": "button", "match": {"label": "LEFT", "action": "press"}, "emit": "render", "as": {}},
      {"event": "button", "match": {"label": "LEFT", "action": "doublePress"},
       "emit": "setCurrentScene", "as": {"sceneId": "weather"}},
      {"event": "button", "match": {"label": "LEFT", "action": "longPress"},
       "emit": "setCurrentScene", "as": {"sceneId": "gone"}},
      # By pin, and with no `action`: every press of the key.
      {"event": "button", "match": {"pin": 4}, "emit": "turnOff", "as": {}},
      # Labels compare as the dispatcher compares them: exactly.
      {"event": "button", "match": {"label": "refresh", "action": "press"}, "emit": "render", "as": {}},
      {"event": "button", "match": {"label": "REFRESH", "action": "doublePress"}, "emit": "myEvent", "as": {}},
      # Not a `button` rule, and a label the frame does not have.
      {"event": "gpio", "match": {"label": "REFRESH"}, "emit": "render", "as": {}},
      {"event": "button", "match": {"label": "A", "action": "press"}, "emit": "render", "as": {}},
    ]
    check index_scene.buttonsLine(config, scenes) ==
      "LEFT (GPIO 5) double press: show Weather, long press: show gone · " &
      "RIGHT (GPIO 4) any press: display off · " &
      "REFRESH (GPIO 3) double press: myEvent"

  test "the buttons row matches a rule on the button's role":
    var config = testConfig()
    # B's role is `next` by default (the contract's roleByLabel); a role in
    # frame.json overrides it.
    config.gpioButtons = @[GPIOButton(pin: 6, label: "B"), GPIOButton(pin: 7, label: "C", role: "next")]
    config.eventMap = %*[
      {"event": "button", "match": {"role": "next", "action": "press"},
       "emit": "setCurrentScene", "as": {"direction": "next"}},
    ]
    check index_scene.buttonsLine(config) ==
      "B (GPIO 6) press: next scene · C (GPIO 7) press: next scene"

  test "the inputs and buttons rows reach the screen":
    initTimeZone()
    withScenesJson("[]") do (_: string):
      var config = testConfig()
      config.gpioButtons = @[GPIOButton(pin: 16, label: "Menu")]
      config.eventMap = %*[
        {"event": "button", "match": {"label": "Menu", "action": "press"}, "emit": "render", "as": {}},
      ]
      let scene = makeIndexScene(config)
      check scene.buildStatusScreen().rows.anyIt(it[0] == "Buttons" and it[1] == "Menu (GPIO 16) press: refresh")
      check "Buttons: Menu (GPIO 16) press: refresh" in scene.buildSceneListText()

  test "the inputs and buttons rows are absent when nothing can drive the frame":
    initTimeZone()
    withScenesJson("[]") do (_: string):
      let screen = makeIndexScene(testConfig()).buildStatusScreen()
      check not screen.rows.anyIt(it[0] == "Inputs")
      check not screen.rows.anyIt(it[0] == "Buttons")

  test "an adopted shell-less frame reports limited remote control, not disabled":
    initTimeZone()
    withScenesJson("[]") do (_: string):
      var config = testConfig()
      # A Buildroot card a backend adopted over the frame's own admin API:
      # no agent, so nothing of ours can run a command on it.
      config.mode = "buildroot"
      config.agent = AgentConfig(agentEnabled: false)
      check index_scene.adminApiOnlyControl(config)
      let row = makeIndexScene(config).buildStatusScreen().rows
      check row.anyIt(it[0] == "Remote control" and it[1].startsWith("limited (no shell access)"))
      check "the backend drives this frame over its own API" in
        index_scene.remoteControlSecurityLine(config)
      # The frame's own listener is what the backend dials, so its scheme is
      # the one the row must be honest about.
      check "UNENCRYPTED http" in index_scene.remoteControlSecurityLine(config)

      # An agent turns it back into ordinary remote control.
      config.agent = AgentConfig(agentEnabled: true)
      check not index_scene.adminApiOnlyControl(config)
      check makeIndexScene(config).buildStatusScreen().rows.anyIt(
        it[0] == "Remote control" and it[1].startsWith("enabled"))

      # An rpios frame is SSH-managed by definition: leave it alone.
      config.mode = "rpios"
      config.agent = AgentConfig(agentEnabled: false)
      check not index_scene.adminApiOnlyControl(config)
      check makeIndexScene(config).buildStatusScreen().rows.anyIt(
        it[0] == "Remote control" and it[1] == "disabled")

      # No backend at all is still plain "disabled".
      config.mode = "buildroot"
      config.serverHost = ""
      check not index_scene.adminApiOnlyControl(config)
      check makeIndexScene(config).buildStatusScreen().rows.anyIt(
        it[0] == "Remote control" and it[1] == "disabled")

  test "the refresh cadence follows the device: paced animation, minute clock, or 5 minutes":
    withScenesJson("[]") do (_: string):
      var config = testConfig()
      let eink = makeIndexScene(config)
      eink.paceRefresh(0.05, epoch = 90.0)
      check eink.refreshInterval == 300.0

      for device in ["pimoroni.hyperpixel2r", "pimoroni.hyperpixel4", "pimoroni.hyperpixel4sq_touch"]:
        config.device = device
        let lcd = makeIndexScene(config)
        lcd.paceRefresh(0.05, epoch = 90.0)   # 30 s past the minute -> wake at the next one
        check abs(lcd.refreshInterval - 30.0) < 1e-6

      config.device = "framebuffer"
      let hdmi = makeIndexScene(config)
      check index_scene.animatesMark(config)
      hdmi.paceRefresh(0.05)
      check hdmi.refreshInterval >= 0.1 and hdmi.refreshInterval <= 3.0
      # Time-based phase: a slow board steps through the same cycle.
      check index_scene.markPhaseAt(0.0) > 0.0
      check index_scene.markPhaseAt(1.5) == index_scene.markPhaseAt(7.5)
      check index_scene.markPhaseAt(1.5) != index_scene.markPhaseAt(3.0)

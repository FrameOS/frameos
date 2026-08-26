import std/[os, json, algorithm, strutils, times, sequtils, unittest]
import pixie
import lib/tz
import ../../../frameos/types
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
      check "Managed via: self-hosted backend (frameos.local:8989)" in text
      check "Frame: http://192.168.1.50:8787" in text
      check "Remote control: disabled" in text
      check "Installed scenes" in text
      check "1. Default Scene" in text

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

  test "the refresh cadence follows the device: paced animation, minute clock, or 5 minutes":
    withScenesJson("[]") do (_: string):
      var config = testConfig()
      let eink = makeIndexScene(config)
      eink.paceRefresh(0.05, epoch = 90.0)
      check eink.refreshInterval == 300.0

      config.device = "inkyHyperPixel2r"
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

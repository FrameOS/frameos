import std/[os, json, algorithm, strutils, times, sequtils, unittest]
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
      check "FrameOS System Info" in text
      check "Name: Kitchen Frame" in text
      check "Device: waveshare" in text
      check "Resolution: 800x480" in text
      check "Rotation: 90" in text
      check "Time zone: Europe/Brussels" in text
      check "Network: " in text
      check "Managed via: self-hosted backend (frameos.local:8989)" in text
      check "Frame: http://192.168.1.50:8787" in text
      check "FrameOS Remote control: disabled" in text
      check "Installed Scenes" in text
      check "1. Default Scene" in text

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

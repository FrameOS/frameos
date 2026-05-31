import std/[json, os, sets, strutils]
import zippy
import assets/apps as appsAsset
import frameos/config
import frameos/device_setup
import frameos/samba_mounts
import frameos/types
import drivers/drivers as drivers
import lib/tz

proc addUnique(packages: var seq[string], seen: var HashSet[string], packageName: string) =
  let normalized = packageName.strip()
  if normalized.len == 0 or seen.contains(normalized):
    return
  seen.incl(normalized)
  packages.add(normalized)

proc addAptPackagesFromConfig(packages: var seq[string], seen: var HashSet[string], config: JsonNode) =
  if config == nil or config.kind != JObject:
    return
  let aptPackages = config{"apt"}
  if aptPackages == nil or aptPackages.kind != JArray:
    return
  for item in aptPackages.items:
    if item.kind == JString:
      packages.addUnique(seen, item.getStr())

proc configFromSources(sources: JsonNode): JsonNode =
  if sources == nil or sources.kind != JObject:
    return nil
  let configSource = sources{"config.json"}
  if configSource == nil or configSource.kind != JString:
    return nil
  try:
    result = parseJson(configSource.getStr("{}"))
  except CatchableError:
    result = nil

proc addAptPackagesFromSources(packages: var seq[string], seen: var HashSet[string], sources: JsonNode) =
  packages.addAptPackagesFromConfig(seen, configFromSources(sources))

proc addAptPackagesFromAppCatalog(
  packages: var seq[string],
  seen: var HashSet[string],
  appsPayload: JsonNode,
  keyword: string,
) =
  if keyword.len == 0 or appsPayload == nil or appsPayload.kind != JObject:
    return
  let apps = appsPayload{"apps"}
  if apps == nil or apps.kind != JObject or not apps.hasKey(keyword):
    return
  packages.addAptPackagesFromConfig(seen, apps[keyword])

proc addAptPackagesFromSceneApp(
  packages: var seq[string],
  seen: var HashSet[string],
  scene: JsonNode,
  keyword: string,
) =
  if keyword.len == 0 or scene == nil or scene.kind != JObject:
    return
  let sceneApps = scene{"apps"}
  if sceneApps == nil or sceneApps.kind != JObject or not sceneApps.hasKey(keyword):
    return
  let sceneApp = sceneApps[keyword]
  if sceneApp == nil or sceneApp.kind != JObject:
    return
  packages.addAptPackagesFromSources(seen, sceneApp{"sources"})

proc appAptPackagesFromScenes*(scenesPayload: JsonNode, appsPayload: JsonNode): seq[string] =
  var seen = initHashSet[string]()
  result = @[]
  if scenesPayload == nil or scenesPayload.kind != JArray:
    return

  for scene in scenesPayload.items:
    if scene == nil or scene.kind != JObject:
      continue
    let nodes = scene{"nodes"}
    if nodes == nil or nodes.kind != JArray:
      continue

    for node in nodes.items:
      if node == nil or node.kind != JObject:
        continue

      let nodeType = node{"type"}.getStr()
      if nodeType == "app":
        let data = node{"data"}
        let keyword = data{"keyword"}.getStr()
        result.addAptPackagesFromAppCatalog(seen, appsPayload, keyword)
        result.addAptPackagesFromSceneApp(seen, scene, keyword)
        result.addAptPackagesFromSources(seen, data{"sources"})
      elif nodeType == "source":
        result.addAptPackagesFromSources(seen, node{"sources"})
        result.addAptPackagesFromSources(seen, node{"data"}{"sources"})

proc readJsonFile(path: string): JsonNode =
  let encoded = readFile(path)
  let decoded =
    if path.endsWith(".gz"):
      uncompress(encoded)
    else:
      encoded
  result = parseJson(decoded)

proc loadAllScenesPayload*(): JsonNode =
  let configuredPath = getEnv("FRAMEOS_ALL_SCENES_JSON")
  if configuredPath.len > 0 and fileExists(configuredPath):
    return readJsonFile(configuredPath)

  for path in ["./all_scenes.json.gz", "./all_scenes.json"]:
    if fileExists(path):
      return readJsonFile(path)

  let scenesPath = getEnv("FRAMEOS_SCENES_JSON")
  if scenesPath.len > 0 and fileExists(scenesPath):
    return readJsonFile(scenesPath)

  for path in ["./scenes.json.gz", "./scenes.json"]:
    if fileExists(path):
      return readJsonFile(path)

  result = newJArray()

proc loadAppsPayload(): JsonNode =
  try:
    result = parseJson(appsAsset.getAppsJson())
  except CatchableError:
    result = %*{"apps": {}}

proc setupExportScenes(data: JsonNode): JsonNode =
  result = newJArray()
  if data == nil or data.kind != JObject:
    return
  let scenes = data{"scenes"}
  if scenes == nil or scenes.kind != JArray:
    return
  for scene in scenes.items:
    if scene == nil or scene.kind != JObject:
      continue
    let execution = scene{"settings"}{"execution"}.getStr("compiled")
    if execution == "interpreted":
      result.add(scene)

proc installServiceFile(sourcePath, destinationPath: string) =
  if not fileExists(sourcePath):
    echo "FrameOS setup: service file missing: " & sourcePath
    return
  writePrivilegedFile(destinationPath, readFile(sourcePath))

proc frameosServiceUser*(): string =
  for candidate in [getEnv("SUDO_USER"), getEnv("USER"), getEnv("LOGNAME")]:
    let user = candidate.strip()
    if user.len > 0:
      return user
  result = "root"

proc frameosServiceContents*(user: string): string =
  result = "[Unit]\n" &
    "Description=FrameOS Service\n" &
    "After=network.target\n" &
    "\n" &
    "[Service]\n" &
    "User=" & user & "\n" &
    "WorkingDirectory=/srv/frameos/current\n" &
    "ExecStart=/srv/frameos/current/frameos\n" &
    "Restart=always\n" &
    "\n" &
    "[Install]\n" &
    "WantedBy=multi-user.target\n"

proc installFrameOSServiceFile() =
  writePrivilegedFile("/etc/systemd/system/frameos.service", frameosServiceContents(frameosServiceUser()))

proc systemdServiceNames(frameOS: FrameOS): seq[string] =
  result = @["frameos.service"]
  if frameOS.frameConfig.agent != nil and frameOS.frameConfig.agent.agentEnabled:
    result.add("frameos_agent.service")

proc ensureSystemdServiceDirectories() =
  discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/systemd/system /etc/cron.d"))

proc setupSystemdServices*(frameOS: FrameOS): SetupResult =
  if not commandExists("systemctl"):
    echo "FrameOS setup: systemd services: systemctl not found, skipping"
    return setupOk()

  echo "FrameOS setup: systemd services: ensuring service directories"
  ensureSystemdServiceDirectories()

  echo "FrameOS setup: systemd services: installing frameos.service"
  installFrameOSServiceFile()

  if frameOS.frameConfig.agent != nil and frameOS.frameConfig.agent.agentEnabled:
    echo "FrameOS setup: systemd services: installing frameos_agent.service"
    installServiceFile("/srv/frameos/agent/current/frameos_agent.service", "/etc/systemd/system/frameos_agent.service")
  else:
    discard runSetupCommand(privilegedCommand("systemctl disable frameos_agent.service"), raiseOnError = false)

  discard runSetupCommand(privilegedCommand("systemctl daemon-reload"))
  discard runSetupCommand(privilegedCommand("systemctl enable " & systemdServiceNames(frameOS).join(" ")))

  result = setupOk()

proc setupReleaseActivation*(currentDir = getAppDir()): SetupResult =
  let normalizedDir = currentDir.strip(chars = {'/'})
  if normalizedDir.len == 0:
    echo "FrameOS setup: release activation: unknown app directory"
    return setupOk()

  let appDir = "/" & normalizedDir
  let stateLink = appDir / "state"

  echo "FrameOS setup: release activation: ensuring shared state directory"
  discard runSetupCommand("mkdir -p /srv/frameos/state")
  discard runSetupCommand("rm -rf " & shellQuote(stateLink) & " && ln -s /srv/frameos/state " & shellQuote(stateLink))

  if appDir.startsWith("/srv/frameos/releases/release_"):
    echo "FrameOS setup: release activation: activating " & appDir
    discard runSetupCommand("rm -rf /srv/frameos/current && ln -s " & shellQuote(appDir) & " /srv/frameos/current")
  else:
    echo "FrameOS setup: release activation: current app directory is " & appDir

  result = setupOk()

proc setupTimezone*(timeZone: string): SetupResult =
  let normalized = timeZone.strip()
  if normalized.len == 0:
    echo "FrameOS setup: timezone: none configured"
    return setupOk()

  let zoneinfoPath = "/usr/share/zoneinfo" / normalized
  if not fileExists(zoneinfoPath):
    echo "FrameOS setup: timezone: zoneinfo file not found for " & normalized
    return setupOk()

  let current = detectSystemTimeZone()
  if current == normalized:
    echo "FrameOS setup: timezone: already " & normalized
    return setupOk()

  if commandExists("timedatectl"):
    let timedateResult = runSetupCommand(
      privilegedCommand("timedatectl set-timezone " & shellQuote(normalized)),
      raiseOnError = false,
    )
    if timedateResult.exitCode == 0:
      return setupOk()

  echo "FrameOS setup: timezone: setting " & normalized
  writePrivilegedFile("/etc/timezone", normalized & "\n")
  discard runSetupCommand(privilegedCommand("ln -sfn " & shellQuote(zoneinfoPath) & " /etc/localtime"))
  result = setupOk()

proc startFrameOSSystemdServices*(configPath = "") =
  if not commandExists("systemctl"):
    echo "FrameOS setup: systemd services: systemctl not found, cannot start services"
    return
  let frameOS = FrameOS(frameConfig: loadConfig(configPath))
  discard runSetupCommand(privilegedCommand("systemctl start " & systemdServiceNames(frameOS).join(" ")))

proc setupAppAptPackages*(): SetupResult =
  setupAptPackages(appAptPackagesFromScenes(loadAllScenesPayload(), loadAppsPayload()))

proc setupFrameOS*(configPath = ""): SetupResult =
  echo "FrameOS setup: starting"
  let frameOS = FrameOS(frameConfig: loadConfig(configPath))
  echo "FrameOS setup: target " & frameOS.frameConfig.device & " (" & frameOS.frameConfig.mode & ")"
  if frameOS.frameConfig.mode == "rpios":
    addSetupResult(result, runSetupStep("app apt packages", proc(): SetupResult = setupAppAptPackages()))
    addSetupResult(result, runSetupStep("samba mounts", proc(): SetupResult = setupSambaMounts(frameOS.frameConfig.mountpoints)))
  else:
    echo "FrameOS setup: app apt packages: skipped for mode " & frameOS.frameConfig.mode
    echo "FrameOS setup: samba mounts: skipped for mode " & frameOS.frameConfig.mode
  if frameOS.frameConfig.mode == "buildroot":
    addSetupResult(result, runSetupStep("timezone", proc(): SetupResult = setupTimezone(frameOS.frameConfig.timeZone)))
  echo "FrameOS setup: driver setup: starting"
  addSetupResult(result, drivers.setup(frameOS))
  echo "FrameOS setup: driver setup: complete"
  addSetupResult(result, runSetupStep("systemd services", proc(): SetupResult = setupSystemdServices(frameOS)))
  addSetupResult(result, runSetupStep("release activation", proc(): SetupResult = setupReleaseActivation()))
  if result.rebootRequired:
    echo "FrameOS setup: reboot required"
  echo "FrameOS setup: complete"

proc writeSetupReleasePayload*(configPath: string) =
  if configPath.len == 0:
    return

  let payload = readJsonFile(configPath)
  writeFile("/srv/frameos/current/frame.json", pretty(payload, indent = 4) & "\n")

  let allScenes = if payload{"scenes"} != nil and payload{"scenes"}.kind == JArray: payload{"scenes"} else: newJArray()
  writeFile("/srv/frameos/current/all_scenes.json.gz", compress(pretty(allScenes, indent = 4) & "\n", dataFormat = dfGzip))
  writeFile("/srv/frameos/current/scenes.json.gz", compress(pretty(setupExportScenes(payload), indent = 4) & "\n", dataFormat = dfGzip))

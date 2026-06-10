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
    setupLog("FrameOS setup: service file missing: " & sourcePath)
    return
  writePrivilegedFile(destinationPath, readFile(sourcePath))

proc frameosServiceUser*(): string =
  for candidate in [getEnv("SUDO_USER"), getEnv("USER"), getEnv("LOGNAME")]:
    let user = candidate.strip()
    if user.len > 0:
      return user
  result = "root"

proc frameosServiceContents*(user: string, consoleOutput = false): string =
  result = "[Unit]\n" &
    "Description=FrameOS Service\n" &
    "After=network.target\n" &
    "\n" &
    "[Service]\n" &
    "User=" & user & "\n" &
    "WorkingDirectory=/srv/frameos/current\n" &
    "ExecStart=/srv/frameos/current/frameos\n" &
    "Restart=always\n" &
    "Type=notify\n" &
    "TimeoutStartSec=300\n" &
    # Restart if the runner loop stops sending WATCHDOG=1 heartbeats. 15 minutes
    # tolerates the slowest legitimate renders (chromium retries, e-ink refresh).
    "WatchdogSec=900\n" &
    # If FrameOS leaks memory, OOM-kill and restart it instead of letting the
    # device swap itself into an unreachable state.
    "MemoryHigh=70%\n" &
    "MemoryMax=80%\n" &
    "MemorySwapMax=64M\n"
  if consoleOutput:
    result &= "StandardOutput=journal+console\n" &
      "StandardError=journal+console\n"
  result &= "\n" &
    "[Install]\n" &
    "WantedBy=multi-user.target\n"

proc installFrameOSServiceFile(consoleOutput = false) =
  writePrivilegedFile("/etc/systemd/system/frameos.service", frameosServiceContents(frameosServiceUser(), consoleOutput))

proc installFrameOSServiceFile(frameOS: FrameOS) =
  if frameOS.frameConfig.mode == "buildroot" and fileExists("/srv/frameos/current/frameos.service"):
    installServiceFile("/srv/frameos/current/frameos.service", "/etc/systemd/system/frameos.service")
  else:
    installFrameOSServiceFile(frameOS.frameConfig.mode == "buildroot")

proc systemdServiceNames(frameOS: FrameOS): seq[string] =
  result = @["frameos.service"]
  if frameOS.frameConfig.agent != nil and frameOS.frameConfig.agent.agentEnabled:
    result.add("frameos_agent.service")

proc ensureSystemdServiceDirectories() =
  discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/systemd/system /etc/cron.d"))

proc setupSystemdServices*(frameOS: FrameOS): SetupResult =
  if not commandExists("systemctl"):
    setupLog("FrameOS setup: systemd services: systemctl not found, skipping")
    return setupOk()

  setupLog("FrameOS setup: systemd services: ensuring service directories")
  ensureSystemdServiceDirectories()

  setupLog("FrameOS setup: systemd services: installing frameos.service")
  installFrameOSServiceFile(frameOS)

  if frameOS.frameConfig.agent != nil and frameOS.frameConfig.agent.agentEnabled:
    setupLog("FrameOS setup: systemd services: installing frameos_agent.service")
    installServiceFile("/srv/frameos/agent/current/frameos_agent.service", "/etc/systemd/system/frameos_agent.service")
  else:
    discard runSetupCommand(privilegedCommand("systemctl disable frameos_agent.service"), raiseOnError = false)

  discard runSetupCommand(privilegedCommand("systemctl daemon-reload"))
  discard runSetupCommand(privilegedCommand("systemctl enable " & systemdServiceNames(frameOS).join(" ")))

  result = setupOk()

proc setupSystemHardening*(): SetupResult =
  result = setupOk()
  if not commandExists("systemctl"):
    setupLog("FrameOS setup: system hardening: systemctl not found, skipping")
    return

  # Hardware watchdog: reboot the device if the kernel itself locks up
  # (e.g. brcmfmac/SDIO wifi firmware wedging the SoC on a Pi Zero 2 W).
  setupLog("FrameOS setup: system hardening: enabling hardware watchdog")
  try:
    discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/systemd/system.conf.d"),
      raiseOnError = false)
    writePrivilegedFile("/etc/systemd/system.conf.d/10-frameos-watchdog.conf",
      "[Manager]\nRuntimeWatchdogSec=15s\nRebootWatchdogSec=2min\n")
  except CatchableError as e:
    setupLog("FrameOS setup: system hardening: hardware watchdog failed: " & e.msg)

  # Wifi power save is a notorious source of dropouts and firmware wedges on
  # the Pi Zero 2 W's brcmfmac chip.
  if dirExists("/etc/NetworkManager"):
    setupLog("FrameOS setup: system hardening: disabling wifi power save")
    try:
      discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/NetworkManager/conf.d"),
        raiseOnError = false)
      writePrivilegedFile("/etc/NetworkManager/conf.d/wifi-powersave-off.conf",
        "[connection]\n# 2 = disable wifi power saving\nwifi.powersave = 2\n")
    except CatchableError as e:
      setupLog("FrameOS setup: system hardening: wifi power save failed: " & e.msg)

  # The memory clamps in frameos.service need the cgroup memory controller,
  # which Raspberry Pi OS only enables with these kernel cmdline flags.
  for cmdlinePath in ["/boot/firmware/cmdline.txt", "/boot/cmdline.txt"]:
    if not fileExists(cmdlinePath):
      continue
    try:
      let current = readFile(cmdlinePath).strip()
      if current.len == 0 or "\n" in current:
        setupLog("FrameOS setup: system hardening: unexpected cmdline format in " & cmdlinePath & ", leaving as is")
      elif "cgroup_enable=memory" in current:
        setupLog("FrameOS setup: system hardening: memory cgroup already enabled")
      else:
        setupLog("FrameOS setup: system hardening: enabling memory cgroup in " & cmdlinePath)
        writePrivilegedFile(cmdlinePath, current & " cgroup_enable=memory cgroup_memory=1\n")
        result.rebootRequired = true
    except CatchableError as e:
      setupLog("FrameOS setup: system hardening: could not update " & cmdlinePath & ": " & e.msg)
    break

proc setupReleaseActivation*(currentDir = getAppDir()): SetupResult =
  let normalizedDir = currentDir.strip(chars = {'/'})
  if normalizedDir.len == 0:
    setupLog("FrameOS setup: release activation: unknown app directory")
    return setupOk()

  let appDir = "/" & normalizedDir
  let stateLink = appDir / "state"

  setupLog("FrameOS setup: release activation: ensuring shared state directory")
  discard runSetupCommand("mkdir -p /srv/frameos/state")
  discard runSetupCommand("rm -rf " & shellQuote(stateLink) & " && ln -s /srv/frameos/state " & shellQuote(stateLink))

  if appDir.startsWith("/srv/frameos/releases/release_"):
    setupLog("FrameOS setup: release activation: activating " & appDir)
    discard runSetupCommand("rm -rf /srv/frameos/current && ln -s " & shellQuote(appDir) & " /srv/frameos/current")
  else:
    setupLog("FrameOS setup: release activation: current app directory is " & appDir)

  result = setupOk()

proc setupTimezone*(timeZone: string): SetupResult =
  let normalized = timeZone.strip()
  if normalized.len == 0:
    setupLog("FrameOS setup: timezone: none configured")
    return setupOk()

  let zoneinfoPath = "/usr/share/zoneinfo" / normalized
  if not fileExists(zoneinfoPath):
    setupLog("FrameOS setup: timezone: zoneinfo file not found for " & normalized)
    return setupOk()

  let current = detectSystemTimeZone()
  if current == normalized:
    setupLog("FrameOS setup: timezone: already " & normalized)
    return setupOk()

  if commandExists("timedatectl"):
    let timedateResult = runSetupCommand(
      privilegedCommand("timedatectl set-timezone " & shellQuote(normalized)),
      raiseOnError = false,
    )
    if timedateResult.exitCode == 0:
      return setupOk()

  setupLog("FrameOS setup: timezone: setting " & normalized)
  writePrivilegedFile("/etc/timezone", normalized & "\n")
  discard runSetupCommand(privilegedCommand("ln -sfn " & shellQuote(zoneinfoPath) & " /etc/localtime"))
  result = setupOk()

proc startFrameOSSystemdServices*(configPath = "") =
  if not commandExists("systemctl"):
    setupLog("FrameOS setup: systemd services: systemctl not found, cannot start services")
    return
  let frameOS = FrameOS(frameConfig: loadConfig(configPath))
  # First-boot setup runs in a oneshot ordered Before=frameos*. Queue the starts
  # so systemd can run them after the setup unit exits instead of waiting here.
  discard runSetupCommand(privilegedCommand("systemctl --no-block start " & systemdServiceNames(frameOS).join(" ")))

proc setupAppAptPackages*(): SetupResult =
  setupAptPackages(appAptPackagesFromScenes(loadAllScenesPayload(), loadAppsPayload()))

proc updateFrameConfigDimensions*(payload: JsonNode, frameConfig: FrameConfig): bool =
  if payload == nil or payload.kind != JObject or frameConfig == nil or frameConfig.width <= 0 or frameConfig.height <= 0:
    return false

  if payload{"width"}.getInt(0) == frameConfig.width and payload{"height"}.getInt(0) == frameConfig.height:
    return false

  payload["width"] = %frameConfig.width
  payload["height"] = %frameConfig.height
  true

proc writeFrameConfigDimensions*(configPath: string, frameConfig: FrameConfig): bool =
  if frameConfig == nil or frameConfig.width <= 0 or frameConfig.height <= 0:
    setupLog("FrameOS setup: frame config: dimensions not persisted; invalid detected dimensions")
    return false

  let path = getConfigFilename(configPath)
  if path.len == 0 or not fileExists(path):
    setupLog("FrameOS setup: frame config: dimensions not persisted; config file not found")
    return false

  var payload = readJsonFile(path)
  if payload == nil or payload.kind != JObject:
    setupLog("FrameOS setup: frame config: dimensions not persisted; config file is not a JSON object")
    return false

  if not updateFrameConfigDimensions(payload, frameConfig):
    setupLog("FrameOS setup: frame config: dimensions already " & $frameConfig.width & "x" & $frameConfig.height)
    return false

  setupLog("FrameOS setup: frame config: updating " & path & " dimensions to " &
    $frameConfig.width & "x" & $frameConfig.height)
  writePrivilegedFile(path, pretty(payload, indent = 4) & "\n")
  true

proc setupFrameOS*(configPath = ""): SetupResult =
  setupLog("FrameOS setup: starting")
  let frameOS = FrameOS(frameConfig: loadConfig(configPath))
  setupLog("FrameOS setup: target " & frameOS.frameConfig.device & " (" & frameOS.frameConfig.mode & ")")
  if frameOS.frameConfig.mode == "rpios":
    addSetupResult(result, runSetupStep("app apt packages", proc(): SetupResult = setupAppAptPackages()))
    addSetupResult(result, runSetupStep("samba mounts", proc(): SetupResult = setupSambaMounts(frameOS.frameConfig.mountpoints)))
  else:
    setupLog("FrameOS setup: app apt packages: skipped for mode " & frameOS.frameConfig.mode)
    setupLog("FrameOS setup: samba mounts: skipped for mode " & frameOS.frameConfig.mode)
  if frameOS.frameConfig.mode in ["buildroot", "rpios"]:
    addSetupResult(result, runSetupStep("timezone", proc(): SetupResult = setupTimezone(frameOS.frameConfig.timeZone)))
  setupLog("FrameOS setup: driver setup: starting")
  addSetupResult(result, drivers.setup(frameOS))
  setupLog("FrameOS setup: driver setup: complete")
  addSetupResult(result, runSetupStep("frame config dimensions", proc(): SetupResult =
    discard writeFrameConfigDimensions(configPath, frameOS.frameConfig)
    setupOk()
  ))
  addSetupResult(result, runSetupStep("systemd services", proc(): SetupResult = setupSystemdServices(frameOS)))
  addSetupResult(result, runSetupStep("system hardening", proc(): SetupResult = setupSystemHardening()))
  addSetupResult(result, runSetupStep("release activation", proc(): SetupResult = setupReleaseActivation()))
  if result.rebootRequired:
    setupLog("FrameOS setup: reboot required")
  setupLog("FrameOS setup: complete")

proc writeSetupReleasePayload*(
  configPath: string,
  frameosCurrentDir = "/srv/frameos/current",
  agentCurrentDir = "/srv/frameos/agent/current",
) =
  if configPath.len == 0:
    return

  let payload = readJsonFile(configPath)
  let frameJson = pretty(payload, indent = 4) & "\n"
  writeFile(frameosCurrentDir / "frame.json", frameJson)
  if dirExists(agentCurrentDir):
    writeFile(agentCurrentDir / "frame.json", frameJson)

  let allScenes = if payload{"scenes"} != nil and payload{"scenes"}.kind == JArray: payload{"scenes"} else: newJArray()
  writeFile(frameosCurrentDir / "all_scenes.json.gz", compress(pretty(allScenes, indent = 4) & "\n", dataFormat = dfGzip))
  writeFile(frameosCurrentDir / "scenes.json.gz", compress(pretty(setupExportScenes(payload), indent = 4) & "\n", dataFormat = dfGzip))

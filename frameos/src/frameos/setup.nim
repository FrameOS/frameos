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
  for candidate in [
    getEnv("FRAMEOS_SERVICE_USER"),
    getEnv("SUDO_USER"),
    getEnv("USER"),
    getEnv("LOGNAME"),
  ]:
    let user = candidate.strip()
    if user.len > 0:
      return user
  result = "root"

proc systemMemoryTotalKb*(): int =
  try:
    for line in readFile("/proc/meminfo").splitLines():
      if line.startsWith("MemTotal:"):
        let parts = line.splitWhitespace()
        if parts.len >= 2:
          return parseInt(parts[1])
  except CatchableError:
    discard
  0

proc serviceMemoryLimits*(memTotalKb: int): tuple[high, max: string] =
  ## FrameOS (and its child processes: ffmpeg, convert, chromium) may use all
  ## memory except what the OS needs to stay reachable. Real frames have hit
  ## 60% of RAM in normal operation, so the cap sits near the edge; it exists
  ## to catch runaway leaks, not to budget normal use. Percentages can't
  ## express a fixed OS reserve across 128MB..8GB devices, so compute
  ## absolute values from MemTotal.
  if memTotalKb <= 0:
    # /proc/meminfo unavailable (non-Linux); leave a generous percentage cap
    return (high: "80%", max: "90%")
  let reserveKb = clamp(memTotalKb div 8, 40 * 1024, 256 * 1024)
  let maxKb = max(memTotalKb - reserveKb, 32 * 1024)
  let highKb = maxKb - max(maxKb div 16, 16 * 1024)
  (high: $highKb & "K", max: $maxKb & "K")

proc frameosServiceContents*(user: string, consoleOutput = false, memTotalKb = -1, framebufferConsole = false): string =
  let memoryLimits = serviceMemoryLimits(if memTotalKb == -1: systemMemoryTotalKb() else: memTotalKb)
  result = "[Unit]\n" &
    "Description=FrameOS Service\n" &
    "After=network.target"
  if framebufferConsole:
    result &= " getty@tty1.service\n" &
      "Conflicts=getty@tty1.service\n"
  else:
    result &= "\n"
  result &= "\n" &
    "[Service]\n" &
    "User=" & user & "\n" &
    "WorkingDirectory=/srv/frameos/current\n" &
    "ExecStart=/srv/frameos/current/frameos\n" &
    "Restart=always\n" &
    "RestartSec=5\n" &
    "Type=notify\n" &
    "TimeoutStartSec=300\n" &
    # Restart if the runner loop stops sending WATCHDOG=1 heartbeats. 15 minutes
    # tolerates the slowest legitimate renders (chromium retries, e-ink refresh).
    "WatchdogSec=900\n" &
    # If FrameOS leaks memory, OOM-kill and restart it instead of letting the
    # device swap itself into an unreachable state.
    "MemoryHigh=" & memoryLimits.high & "\n" &
    "MemoryMax=" & memoryLimits.max & "\n" &
    "MemorySwapMax=64M\n" &
    "ExecStopPost=-+/bin/sh -lc 'mkdir -p /srv/frameos/runtime; umask 022; printf \"serviceResult=%s\\nexitCode=%s\\nexitStatus=%s\\n\" \"$SERVICE_RESULT\" \"$EXIT_CODE\" \"$EXIT_STATUS\" > /srv/frameos/runtime/frameos-last-exit'\n"
  if framebufferConsole:
    result &= "TTYPath=/dev/tty1\n" &
      "StandardInput=tty-force\n" &
      "TTYReset=yes\n" &
      "ExecStopPost=-+/bin/systemd-run --quiet --collect --on-active=10 /bin/sh -lc '/bin/systemctl show -p ActiveState --value frameos.service 2>/dev/null | /bin/grep -xq -e active -e activating -e reloading && exit 0; /bin/systemctl reset-failed getty@tty1.service; /bin/systemctl start getty@tty1.service'\n"
  if consoleOutput:
    result &= "StandardOutput=journal+console\n" &
      "StandardError=journal+console\n"
  result &= "\n" &
    "[Install]\n" &
    "WantedBy=multi-user.target\n"

proc installFrameOSServiceFile(consoleOutput = false, framebufferConsole = false) =
  writePrivilegedFile(
    "/etc/systemd/system/frameos.service",
    frameosServiceContents(frameosServiceUser(), consoleOutput, framebufferConsole = framebufferConsole),
  )

proc installFrameOSServiceFile(frameOS: FrameOS) =
  if frameOS.frameConfig.mode == "buildroot" and fileExists("/srv/frameos/current/frameos.service"):
    installServiceFile("/srv/frameos/current/frameos.service", "/etc/systemd/system/frameos.service")
  else:
    installFrameOSServiceFile(
      frameOS.frameConfig.mode == "buildroot",
      framebufferConsole = frameOS.frameConfig.device == "framebuffer",
    )

proc systemdServiceNames(frameOS: FrameOS): seq[string] =
  result = @["frameos.service"]
  if frameOS.frameConfig.agent != nil and frameOS.frameConfig.agent.agentEnabled:
    result.add("frameos-remote.service")

proc ensureSystemdServiceDirectories() =
  discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/systemd/system /etc/cron.d"))

proc legacyRemoteCleanupScript(delaySeconds = 0): string =
  result = "for service in frameos_agent.service frameos-agent.service; do " &
    "systemctl disable --now \"$service\" >/dev/null 2>&1 || true; " &
    "systemctl reset-failed \"$service\" >/dev/null 2>&1 || true; " &
    "done; " &
    "rm -f " &
    "/etc/systemd/system/frameos_agent.service " &
    "/etc/systemd/system/frameos-agent.service " &
    "/etc/systemd/system/multi-user.target.wants/frameos_agent.service " &
    "/etc/systemd/system/multi-user.target.wants/frameos-agent.service " &
    "/etc/systemd/system/default.target.wants/frameos_agent.service " &
    "/etc/systemd/system/default.target.wants/frameos-agent.service " &
    "/lib/systemd/system/frameos_agent.service " &
    "/lib/systemd/system/frameos-agent.service " &
    "/usr/lib/systemd/system/frameos_agent.service " &
    "/usr/lib/systemd/system/frameos-agent.service >/dev/null 2>&1 || true; " &
    "if command -v pgrep >/dev/null 2>&1; then " &
    "for pid in $(pgrep -f '[f]rameos_agent' 2>/dev/null || true); do " &
    "exe=$(readlink -f \"/proc/$pid/exe\" 2>/dev/null || true); " &
    "case \"$exe\" in /srv/frameos/agent/*/frameos_agent) kill \"$pid\" >/dev/null 2>&1 || true ;; esac; " &
    "done; " &
    "fi; " &
    "rm -rf /srv/frameos/agent >/dev/null 2>&1 || true; " &
    "systemctl daemon-reload >/dev/null 2>&1 || true"
  if delaySeconds > 0:
    result = "sleep " & $delaySeconds & "; " & result

proc scheduleLegacyRemoteCleanupCommand(): string =
  let script = legacyRemoteCleanupScript(delaySeconds = 1)
  if commandExists("systemd-run"):
    return privilegedCommand(
      "systemd-run --quiet --unit=frameos-remote-disable-legacy-service --collect /bin/sh -lc " &
      shellQuote(script)
    )
  privilegedCommand("sh -c " & shellQuote("nohup sh -c " & shellQuote(script) & " >/dev/null 2>&1 &"))

proc setupSystemdServices*(frameOS: FrameOS): SetupResult =
  if not commandExists("systemctl"):
    setupLog("FrameOS setup: systemd services: systemctl not found, skipping")
    return setupOk()

  setupLog("FrameOS setup: systemd services: ensuring service directories")
  ensureSystemdServiceDirectories()

  setupLog("FrameOS setup: systemd services: installing frameos.service")
  installFrameOSServiceFile(frameOS)

  if frameOS.frameConfig.agent != nil and frameOS.frameConfig.agent.agentEnabled:
    setupLog("FrameOS setup: systemd services: installing frameos-remote.service")
    installServiceFile("/srv/frameos/remote/current/frameos-remote.service", "/etc/systemd/system/frameos-remote.service")
  else:
    discard runSetupCommand(privilegedCommand("systemctl disable frameos-remote.service"), raiseOnError = false)

  discard runSetupCommand(privilegedCommand("systemctl daemon-reload"))
  discard runSetupCommand(privilegedCommand("systemctl enable " & systemdServiceNames(frameOS).join(" ")))
  discard runSetupCommand(scheduleLegacyRemoteCleanupCommand(), raiseOnError = false)

  result = setupOk()

proc privilegedFileNeedsUpdate(path, content: string): bool =
  try:
    result = not fileExists(path) or readFile(path) != content
  except CatchableError:
    result = true

proc deviceNodeExists(path: string): bool =
  # fileExists() is false for device nodes; stat via getFileInfo instead
  try:
    discard getFileInfo(path)
    true
  except CatchableError:
    false

proc wirelessInterfaces(): seq[string] =
  try:
    for kind, path in walkDir("/sys/class/net"):
      if dirExists(path / "wireless"):
        result.add(lastPathPart(path))
  except CatchableError:
    discard

proc cgroupIndicatesRemoteService*(cgroupContent: string): bool =
  for line in cgroupContent.splitLines():
    if "frameos-remote.service" in line or "frameos_agent.service" in line or "frameos-agent.service" in line:
      return true
  false

proc runningUnderFrameosRemote*(): bool =
  ## Deploys can run "frameos setup" through the remote websocket connection;
  ## the spawned process (and its sudo children) stays in the remote cgroup.
  if getEnv("FRAMEOS_SETUP_UNDER_REMOTE").normalize in ["1", "true", "yes"] or
      getEnv("FRAMEOS_SETUP_UNDER_AGENT").normalize in ["1", "true", "yes"]:
    return true
  try:
    result = fileExists("/proc/self/cgroup") and
      cgroupIndicatesRemoteService(readFile("/proc/self/cgroup"))
  except CatchableError:
    result = false

proc setupSystemHardening*(liveApply = true): SetupResult =
  result = setupOk()
  if not commandExists("systemctl"):
    setupLog("FrameOS setup: system hardening: systemctl not found, skipping")
    return

  # Hardware watchdog: reboot the device if the kernel itself locks up
  # (e.g. brcmfmac/SDIO wifi firmware wedging the SoC on a Pi Zero 2 W).
  try:
    if not deviceNodeExists("/dev/watchdog"):
      setupLog("FrameOS setup: system hardening: /dev/watchdog missing; " &
        "the hardware watchdog config will only take effect once the watchdog driver is available")
    const watchdogConfPath = "/etc/systemd/system.conf.d/10-frameos-watchdog.conf"
    const watchdogConf = "[Manager]\nRuntimeWatchdogSec=15s\nRebootWatchdogSec=2min\n"
    if privilegedFileNeedsUpdate(watchdogConfPath, watchdogConf):
      setupLog("FrameOS setup: system hardening: enabling hardware watchdog")
      discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/systemd/system.conf.d"),
        raiseOnError = false)
      writePrivilegedFile(watchdogConfPath, watchdogConf)
      if liveApply:
        # Apply without a reboot; PID 1 re-executes in place.
        discard runSetupCommand(privilegedCommand("systemctl daemon-reexec"), raiseOnError = false)
      else:
        setupLog("FrameOS setup: system hardening: deferring systemd daemon-reexec; " &
          "the watchdog config applies at the next reboot")
    else:
      setupLog("FrameOS setup: system hardening: hardware watchdog already enabled")
  except CatchableError as e:
    setupLog("FrameOS setup: system hardening: hardware watchdog failed: " & e.msg)

  # Wifi power save is a notorious source of dropouts and firmware wedges on
  # the Pi Zero 2 W's brcmfmac chip. Persist the NetworkManager setting and
  # also switch it off on the running interfaces right away.
  if dirExists("/etc/NetworkManager"):
    try:
      const powersaveConfPath = "/etc/NetworkManager/conf.d/wifi-powersave-off.conf"
      const powersaveConf = "[connection]\n# 2 = disable wifi power saving\nwifi.powersave = 2\n"
      if privilegedFileNeedsUpdate(powersaveConfPath, powersaveConf):
        setupLog("FrameOS setup: system hardening: disabling wifi power save")
        discard runSetupCommand(privilegedCommand("install -d -m 755 /etc/NetworkManager/conf.d"),
          raiseOnError = false)
        writePrivilegedFile(powersaveConfPath, powersaveConf)
        if liveApply:
          # reload (unlike restart) re-reads config without dropping connections
          discard runSetupCommand(privilegedCommand("systemctl reload NetworkManager"), raiseOnError = false)
        else:
          setupLog("FrameOS setup: system hardening: deferring NetworkManager reload; " &
            "the power save config applies at the next reboot")
      else:
        setupLog("FrameOS setup: system hardening: wifi power save already disabled in NetworkManager")
    except CatchableError as e:
      setupLog("FrameOS setup: system hardening: wifi power save failed: " & e.msg)

  if not liveApply:
    setupLog("FrameOS setup: system hardening: deferring live wifi power_save changes")
  elif commandExists("iw"):
    for interfaceName in wirelessInterfaces():
      setupLog("FrameOS setup: system hardening: power_save off for " & interfaceName)
      discard runSetupCommand(
        privilegedCommand("iw dev " & shellQuote(interfaceName) & " set power_save off"),
        raiseOnError = false)

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
  # When setup runs as a child of FrameOS Remote (deploys over the remote websocket),
  # live-applying network/systemd changes can drop the very connection the
  # deploy is running on. Write the configs but defer their activation.
  let liveApply = not runningUnderFrameosRemote()
  if not liveApply:
    setupLog("FrameOS setup: running inside frameos-remote.service; deferring live system changes " &
      "to keep the remote connection alive")
  addSetupResult(result, runSetupStep("system hardening", proc(): SetupResult = setupSystemHardening(liveApply)))
  addSetupResult(result, runSetupStep("release activation", proc(): SetupResult = setupReleaseActivation()))
  if result.rebootRequired:
    setupLog("FrameOS setup: reboot required")
  setupLog("FrameOS setup: complete")

proc writeSetupReleasePayload*(
  configPath: string,
  frameosCurrentDir = "/srv/frameos/current",
  remoteCurrentDir = "/srv/frameos/remote/current",
) =
  if configPath.len == 0:
    return

  let payload = readJsonFile(configPath)
  let frameJson = pretty(payload, indent = 4) & "\n"
  writeFile(frameosCurrentDir / "frame.json", frameJson)
  if dirExists(remoteCurrentDir):
    writeFile(remoteCurrentDir / "frame.json", frameJson)

  let allScenes = if payload{"scenes"} != nil and payload{"scenes"}.kind == JArray: payload{"scenes"} else: newJArray()
  writeFile(frameosCurrentDir / "all_scenes.json.gz", compress(pretty(allScenes, indent = 4) & "\n", dataFormat = dfGzip))
  writeFile(frameosCurrentDir / "scenes.json.gz", compress(pretty(setupExportScenes(payload), indent = 4) & "\n", dataFormat = dfGzip))

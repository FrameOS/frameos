import std/[httpclient, json, os, strutils, tables, times]
import zippy

import frameos/config
import frameos/device_setup
from frameos/setup import frameosServiceContents, frameosServiceUser
import frameos/utils/http_client
import frameos/utils/process
import frameos/version

const
  GitHubLatestReleaseApi* = "https://api.github.com/repos/FrameOS/frameos/releases/latest"
  GitHubReleaseDownloadPrefix* = "https://github.com/FrameOS/frameos/releases/download/"
  SupportedReleaseTargets = [
    "debian-buster",
    "debian-bullseye",
    "debian-bookworm",
    "debian-trixie",
    "ubuntu-22.04",
    "ubuntu-24.04",
    "ubuntu-26.04",
  ]
  SupportedArches = ["arm64", "armhf", "amd64"]

type
  FrameOSReleaseInfo* = object
    version*: string
    tagName*: string
    target*: string
    assetName*: string
    assetUrl*: string
    htmlUrl*: string

  FrameOSUpgradeOptions* = object
    dryRun*: bool
    yes*: bool

  StagedFrameOSRelease = object
    name: string
    frameosReleaseDir: string
    remoteReleaseDir: string
    serviceUser: string
    setupStatus: int

proc frameosInstallDir*(): string =
  getEnv("FRAMEOS_DIR", "/srv/frameos").strip(leading = false, trailing = true, chars = {'/'})

proc frameosRemoteInstallDir*(): string =
  getEnv("FRAMEOS_REMOTE_DIR", getEnv("FRAMEOS_AGENT_DIR", frameosInstallDir() / "remote")).strip(
    leading = false,
    trailing = true,
    chars = {'/'},
  )

proc frameosAssetsDir(): string =
  getEnv("FRAMEOS_ASSETS_DIR", "/srv/assets").strip(leading = false, trailing = true, chars = {'/'})

proc frameosStateDir*(): string =
  frameosInstallDir() / "state"

proc frameosUpgradeStatusPath*(): string =
  frameosStateDir() / "upgrade-status.json"

proc nowIso(): string =
  format(now().utc, "yyyy-MM-dd'T'HH:mm:ss'Z'")

proc writeUpgradeStatus*(payload: JsonNode) =
  if payload.kind != JObject:
    return
  payload["updated_at"] = %nowIso()
  createDir(frameosStateDir())
  writeFile(frameosUpgradeStatusPath(), pretty(payload, indent = 2) & "\n")

proc deleteIfPresent(payload: JsonNode, key: string) =
  if payload != nil and payload.kind == JObject and payload.hasKey(key):
    payload.delete(key)

proc readUpgradeStatus*(): JsonNode =
  try:
    if fileExists(frameosUpgradeStatusPath()):
      let payload = parseFile(frameosUpgradeStatusPath())
      if payload.kind == JObject:
        return payload
  except CatchableError:
    discard
  %*{"status": "idle"}

proc normalizeReleaseVersion*(value: string): string =
  publishedFrameOSVersion(value)

proc parseVersionParts(value: string): seq[int] =
  let normalized = normalizeReleaseVersion(value)
  if normalized == "unknown":
    return @[]
  for part in normalized.split('.'):
    try:
      result.add(parseInt(part))
    except CatchableError:
      return @[]

proc compareFrameOSVersions*(left, right: string): int =
  let leftParts = parseVersionParts(left)
  let rightParts = parseVersionParts(right)
  if leftParts.len == 0 or rightParts.len == 0:
    return 0
  for i in 0 ..< max(leftParts.len, rightParts.len):
    let leftPart = if i < leftParts.len: leftParts[i] else: 0
    let rightPart = if i < rightParts.len: rightParts[i] else: 0
    if leftPart < rightPart:
      return -1
    if leftPart > rightPart:
      return 1
  0

proc parseOsRelease(path = "/etc/os-release"): Table[string, string] =
  if not fileExists(path):
    return
  for rawLine in readFile(path).splitLines():
    let line = rawLine.strip()
    if line.len == 0 or line.startsWith("#") or "=" notin line:
      continue
    let parts = line.split("=", 1)
    var value = parts[1].strip()
    if value.len >= 2 and ((value[0] == '"' and value[^1] == '"') or (value[0] == '\'' and value[^1] == '\'')):
      value = value[1 .. ^2]
    result[parts[0]] = value

proc detectArch(): string =
  let overrideArch = getEnv("FRAMEOS_ARCH_OVERRIDE").strip()
  if overrideArch.len > 0:
    return overrideArch
  let uname = runShellCapture("uname -m", timeoutMs = 5000, maxOutputBytes = 4096).output.strip().splitLines()[0]
  case uname
  of "aarch64", "arm64", "armv8":
    "arm64"
  of "armv8l", "armv7l", "armv6l", "armhf":
    "armhf"
  of "x86_64", "amd64":
    "amd64"
  else:
    raise newException(ValueError, "Unsupported CPU architecture: " & uname & ". Supported architectures: " & SupportedArches.join(", "))

proc normalizeDistroRelease(values: Table[string, string]): tuple[distro, release: string] =
  result.distro = getEnv("FRAMEOS_DISTRO_OVERRIDE", values.getOrDefault("ID", "")).strip()
  result.release = getEnv("FRAMEOS_OS_RELEASE_OVERRIDE", "").strip()
  if result.release.len == 0:
    result.release = values.getOrDefault("VERSION_CODENAME", "").strip()
  if result.release.len == 0:
    result.release = values.getOrDefault("UBUNTU_CODENAME", "").strip()
  if result.release.len == 0:
    result.release = values.getOrDefault("VERSION_ID", "").strip()

  if result.distro in ["raspbian", "raspios"]:
    result.distro = "debian"
  elif result.distro notin ["debian", "ubuntu"] and "debian" in values.getOrDefault("ID_LIKE", ""):
    result.distro = "debian"

  if result.distro == "ubuntu":
    case result.release
    of "jammy":
      result.release = "22.04"
    of "noble":
      result.release = "24.04"
    of "resolute":
      result.release = "26.04"
    else:
      if result.release.startsWith("22.04"):
        result.release = "22.04"
      elif result.release.startsWith("24.04"):
        result.release = "24.04"
      elif result.release.startsWith("26.04"):
        result.release = "26.04"

proc detectUpgradeTarget*(): string =
  let overrideTarget = getEnv("FRAMEOS_TARGET").strip()
  if overrideTarget.len > 0:
    return overrideTarget
  let arch = detectArch()
  let values = parseOsRelease()
  if values.len == 0:
    raise newException(ValueError, "Cannot read /etc/os-release")
  let detected = normalizeDistroRelease(values)
  let targetBase = detected.distro & "-" & detected.release
  if targetBase notin SupportedReleaseTargets:
    raise newException(
      ValueError,
      "Unsupported OS release: " & targetBase & ". Supported release targets: " & SupportedReleaseTargets.join(", "),
    )
  targetBase & "-" & arch

proc validateGithubReleaseAssetUrl*(url, version: string) =
  let expectedPrefix = GitHubReleaseDownloadPrefix & "v" & version & "/"
  if not url.startsWith(expectedPrefix):
    raise newException(ValueError, "Refusing non-FrameOS GitHub release asset URL: " & url)
  if not url.endsWith(".tar.gz"):
    raise newException(ValueError, "Refusing release asset that is not a .tar.gz archive: " & url)

proc releaseInfoFromPayload*(payload: JsonNode, target: string): FrameOSReleaseInfo =
  if payload == nil or payload.kind != JObject:
    raise newException(ValueError, "GitHub release payload is not an object")
  if payload{"draft"}.getBool(false) or payload{"prerelease"}.getBool(false):
    raise newException(ValueError, "Latest FrameOS release is not a stable release")
  result.tagName = payload{"tag_name"}.getStr("")
  result.version = normalizeReleaseVersion(result.tagName)
  if result.version == "unknown":
    raise newException(ValueError, "Latest FrameOS release has no version tag")
  result.target = target
  result.assetName = "frameos-" & result.version & "-" & target & ".tar.gz"
  result.htmlUrl = payload{"html_url"}.getStr("")
  let assets = payload{"assets"}
  if assets == nil or assets.kind != JArray:
    raise newException(ValueError, "Latest FrameOS release has no assets")
  for asset in assets.items:
    if asset{"name"}.getStr("") == result.assetName:
      result.assetUrl = asset{"browser_download_url"}.getStr("")
      break
  if result.assetUrl.len == 0:
    raise newException(ValueError, "Latest FrameOS release has no asset for " & target & " (" & result.assetName & ")")
  validateGithubReleaseAssetUrl(result.assetUrl, result.version)

proc latestFrameOSRelease*(target = ""): FrameOSReleaseInfo =
  let resolvedTarget = if target.len > 0: target else: detectUpgradeTarget()
  var headers = newHttpHeaders()
  headers["Accept"] = "application/vnd.github+json"
  headers["User-Agent"] = "FrameOS/" & compiledFrameOSVersion()
  let body = boundedGetContent(
    GitHubLatestReleaseApi,
    headers = headers,
    maxBytes = 2 * 1024 * 1024,
    maxSeconds = 30,
  )
  releaseInfoFromPayload(parseJson(body), resolvedTarget)

proc currentFrameConfigPath(): string =
  frameosInstallDir() / "current" / "frame.json"

proc adminSessionSaltPath(): string =
  frameosStateDir() / "admin_session_salt"

proc currentFrameConfig(): JsonNode =
  try:
    if fileExists(currentFrameConfigPath()):
      let payload = parseFile(currentFrameConfigPath())
      if payload.kind == JObject:
        return payload
  except CatchableError:
    discard
  try:
    let payload = parseFile(getConfigFilename())
    if payload.kind == JObject:
      return payload
  except CatchableError:
    discard
  %*{}

proc installedFrameOSVersion*(): string =
  let compiled = normalizeReleaseVersion(compiledFrameOSVersion())
  if compiled != "unknown":
    return compiled
  let config = currentFrameConfig()
  normalizeReleaseVersion(config{"frameosVersion"}.getStr(config{"frameos_version"}.getStr("")))

proc releaseJson(release: FrameOSReleaseInfo): JsonNode =
  %*{
    "version": release.version,
    "tag_name": release.tagName,
    "target": release.target,
    "asset_name": release.assetName,
    "asset_url": release.assetUrl,
    "html_url": release.htmlUrl,
  }

proc applyLatestReleaseToStatus*(payload: JsonNode, release: FrameOSReleaseInfo, currentVersion: string) =
  payload["latest_release"] = releaseJson(release)
  payload["latest_version"] = %release.version
  payload["update_available"] = %(compareFrameOSVersions(currentVersion, release.version) < 0 or currentVersion == "unknown")
  deleteIfPresent(payload, "latest_error")

proc frameOSUpgradeStatusPayload*(checkLatest = false): JsonNode =
  var targetError = ""
  let target =
    try:
      detectUpgradeTarget()
    except CatchableError as error:
      targetError = error.msg
      ""
  result = readUpgradeStatus()
  result["current_version"] = %installedFrameOSVersion()
  result["compiled_version"] = %compiledFrameOSVersion()
  result["target"] = %target
  if targetError.len > 0:
    result["target_error"] = %targetError
  if checkLatest and target.len > 0:
    try:
      let release = latestFrameOSRelease(target)
      applyLatestReleaseToStatus(result, release, installedFrameOSVersion())
    except CatchableError as error:
      result["latest_error"] = %error.msg
      result["update_available"] = %false
  elif checkLatest and targetError.len > 0:
    result["latest_error"] = %targetError
    result["update_available"] = %false
  elif not result.hasKey("update_available"):
    result["update_available"] = %false

proc realPath(path: string): string =
  let resolved = runShellCapture("readlink -f " & shellQuote(path), timeoutMs = 5000, maxOutputBytes = 4096).output.strip()
  if resolved.len > 0:
    resolved
  else:
    path

proc ensureCompatibleInstalledLayout(release: FrameOSReleaseInfo) =
  let currentDir = frameosInstallDir() / "current"
  if not fileExists(currentDir / "frame.json"):
    raise newException(ValueError, "FrameOS upgrade requires an installed frame at " & currentDir)
  let currentReleaseDir = realPath(currentDir)
  if not currentReleaseDir.startsWith(frameosInstallDir() / "releases" / ""):
    raise newException(ValueError, "FrameOS upgrade requires " & currentDir & " to point at a release under " & frameosInstallDir() / "releases")
  let config = currentFrameConfig()
  let mode = config{"mode"}.getStr("rpios")
  if mode != "rpios":
    raise newException(ValueError, "FrameOS upgrade supports installed Raspberry Pi OS frames only; current mode is " & mode)
  if not commandExists("systemctl"):
    raise newException(ValueError, "FrameOS upgrade requires systemd/systemctl")
  if not commandExists("tar"):
    raise newException(ValueError, "FrameOS upgrade requires tar")
  if not commandExists("curl") and not commandExists("wget"):
    raise newException(ValueError, "FrameOS upgrade requires curl or wget")
  if not commandSucceeds("test \"$(id -u)\" = 0 || sudo -n true >/dev/null 2>&1"):
    raise newException(ValueError, "FrameOS upgrade must run as root or with passwordless sudo")
  discard release

proc downloadReleaseArchive(release: FrameOSReleaseInfo, destination: string) =
  validateGithubReleaseAssetUrl(release.assetUrl, release.version)
  if commandExists("curl"):
    discard runSetupCommand(
      "curl -fL --proto '=https' --tlsv1.2 " & shellQuote(release.assetUrl) & " -o " & shellQuote(destination)
    )
  elif commandExists("wget"):
    discard runSetupCommand("wget -qO " & shellQuote(destination) & " " & shellQuote(release.assetUrl))
  else:
    raise newException(ValueError, "Missing required command: curl or wget")

proc findFileNamed(root, name: string): string =
  for path in walkDirRec(root):
    if fileExists(path) and lastPathPart(path) == name:
      return path
  ""

proc copyCompressedPayload(releaseDir, oldDir, compressedName, plainName: string) =
  if oldDir.len > 0 and fileExists(oldDir / compressedName):
    copyFile(oldDir / compressedName, releaseDir / compressedName)
  elif oldDir.len > 0 and fileExists(oldDir / plainName):
    writeFile(releaseDir / compressedName, compress(readFile(oldDir / plainName), dataFormat = dfGzip))
  else:
    writeFile(releaseDir / compressedName, compress("[]\n", dataFormat = dfGzip))

proc copyScenePayloads(releaseDir, oldDir: string) =
  copyCompressedPayload(releaseDir, oldDir, "all_scenes.json.gz", "all_scenes.json")
  copyCompressedPayload(releaseDir, oldDir, "scenes.json.gz", "scenes.json")

proc copyAdminSessionSaltForUpgrade*(releaseDir: string) =
  let targetSalt = releaseDir / "frame.json.admin_session_salt"
  let sharedSalt = adminSessionSaltPath()
  let legacySalt = currentFrameConfigPath() & ".admin_session_salt"
  if fileExists(sharedSalt):
    copyFile(sharedSalt, targetSalt)
  elif fileExists(legacySalt):
    copyFile(legacySalt, targetSalt)

proc writeFrameConfigForUpgrade(configPath, destination, version: string) =
  var payload = parseFile(configPath)
  if payload.kind != JObject:
    raise newException(ValueError, "Current frame config is not a JSON object: " & configPath)
  payload["frameosVersion"] = %version
  writeFile(destination, pretty(payload, indent = 4) & "\n")

proc serviceUserFromFile(path: string): string =
  try:
    if fileExists(path):
      for line in readFile(path).splitLines():
        if line.startsWith("User="):
          let user = line["User=".len .. ^1].strip()
          if user.len > 0:
            return user
  except CatchableError:
    discard
  frameosServiceUser()

proc remoteServiceContents(user: string): string =
  "[Unit]\n" &
    "Description=FrameOS Remote (auto-reconnect, hardened)\n" &
    "After=network-online.target\n" &
    "Wants=network-online.target\n\n" &
    "[Service]\n" &
    "Type=simple\n" &
    "User=" & user & "\n" &
    "WorkingDirectory=" & frameosRemoteInstallDir() & "/current\n" &
    "ExecStart=" & frameosRemoteInstallDir() & "/current/frameos_remote\n" &
    "Restart=always\n" &
    "RestartSec=5\n" &
    "LimitNOFILE=65536\n" &
    "PrivateTmp=yes\n" &
    "ProtectSystem=full\n" &
    "ReadWritePaths=/etc/systemd/system /etc/cron.d /boot\n\n" &
    "[Install]\n" &
    "WantedBy=multi-user.target\n"

proc copyDirIfExists(source, destination: string) =
  if dirExists(source):
    copyDir(source, destination)

proc stageFrameOSRelease(release: FrameOSReleaseInfo): StagedFrameOSRelease =
  let timestamp = format(now(), "yyyyMMddHHmmss")
  result.name = "release_upgrade_" & timestamp & "_" & release.version.replace(".", "_")
  result.frameosReleaseDir = frameosInstallDir() / "releases" / result.name
  result.remoteReleaseDir = frameosRemoteInstallDir() / "releases" / result.name
  if dirExists(result.frameosReleaseDir) or dirExists(result.remoteReleaseDir):
    raise newException(ValueError, "Release directory already exists: " & result.name)

  let workDir = getTempDir() / ("frameos-upgrade-" & $getCurrentProcessId() & "-" & timestamp)
  try:
    createDir(workDir)
    createDir(workDir / "extract")
    createDir(result.frameosReleaseDir)
    createDir(result.remoteReleaseDir)
    createDir(frameosInstallDir() / "logs")
    createDir(frameosRemoteInstallDir() / "logs")
    createDir(frameosStateDir())
    createDir(frameosAssetsDir())

    setupLog("FrameOS upgrade: downloading " & release.assetName)
    downloadReleaseArchive(release, workDir / "frameos.tar.gz")
    discard runSetupCommand("tar -xzf " & shellQuote(workDir / "frameos.tar.gz") & " -C " & shellQuote(workDir / "extract"))

    let frameosBinary = findFileNamed(workDir / "extract", "frameos")
    var remoteBinary = findFileNamed(workDir / "extract", "frameos_remote")
    if remoteBinary.len == 0:
      remoteBinary = findFileNamed(workDir / "extract", "frameos_agent")
    if frameosBinary.len == 0:
      raise newException(ValueError, "The FrameOS release did not contain a frameos binary for " & release.target)
    if remoteBinary.len == 0:
      raise newException(ValueError, "The FrameOS release did not contain a frameos_remote binary for " & release.target)

    let artifactRoot = parentDir(frameosBinary)
    discard runSetupCommand("install -m 0755 " & shellQuote(frameosBinary) & " " & shellQuote(result.frameosReleaseDir / "frameos"))
    discard runSetupCommand("install -m 0755 " & shellQuote(remoteBinary) & " " & shellQuote(result.remoteReleaseDir / "frameos_remote"))

    copyDirIfExists(artifactRoot / "drivers", result.frameosReleaseDir / "drivers")
    copyDirIfExists(artifactRoot / "scenes", result.frameosReleaseDir / "scenes")
    if dirExists(artifactRoot / "vendor"):
      createDir(frameosInstallDir() / "vendor")
      discard runSetupCommand("cp -R " & shellQuote(artifactRoot / "vendor" / ".") & " " & shellQuote(frameosInstallDir() / "vendor" / ""))

    let oldReleaseDir = realPath(frameosInstallDir() / "current")
    writeFrameConfigForUpgrade(currentFrameConfigPath(), result.frameosReleaseDir / "frame.json", release.version)
    copyFile(result.frameosReleaseDir / "frame.json", result.remoteReleaseDir / "frame.json")
    copyScenePayloads(result.frameosReleaseDir, oldReleaseDir)

    copyAdminSessionSaltForUpgrade(result.frameosReleaseDir)

    let serviceUser = serviceUserFromFile("/etc/systemd/system/frameos.service")
    result.serviceUser = serviceUser
    writeFile(
      result.frameosReleaseDir / "frameos.service",
      frameosServiceContents(serviceUser, framebufferConsole = currentFrameConfig(){"device"}.getStr("") == "framebuffer"),
    )
    writeFile(result.remoteReleaseDir / "frameos-remote.service", remoteServiceContents(serviceUser))

    discard runSetupCommand(
      privilegedCommand(
        "chown -R " & shellQuote(serviceUser) & " " &
        shellQuote(result.frameosReleaseDir) & " " &
        shellQuote(result.remoteReleaseDir) & " " &
        shellQuote(frameosStateDir()) & " " &
        shellQuote(frameosInstallDir() / "logs") & " " &
        shellQuote(frameosRemoteInstallDir() / "logs") & " " &
        shellQuote(frameosAssetsDir())
      ),
      raiseOnError = false,
    )
  finally:
    if dirExists(workDir):
      removeDir(workDir)

proc switchCurrentSymlink(linkPath, targetPath: string) =
  discard runSetupCommand(privilegedCommand("rm -rf " & shellQuote(linkPath) & " && ln -s " & shellQuote(targetPath) & " " & shellQuote(linkPath)))

proc runStagedSetup(staged: var StagedFrameOSRelease) =
  let serviceUserEnv =
    if staged.serviceUser.len > 0:
      "FRAMEOS_SERVICE_USER=" & shellQuote(staged.serviceUser) & " "
    else:
      ""
  let setupResult = runSetupCommand(
    "cd " & shellQuote(staged.frameosReleaseDir) & " && " & serviceUserEnv & "./frameos setup",
    raiseOnError = false,
  )
  staged.setupStatus = setupResult.exitCode
  if staged.setupStatus != 0 and staged.setupStatus != 2:
    raise newException(OSError, "FrameOS setup failed with exit code " & $staged.setupStatus)

proc remoteEnabled(): bool =
  let config = currentFrameConfig()
  config{"agent"}{"agentEnabled"}.getBool(false)

proc restartFrameOSServices(rebootRequired: bool) =
  if rebootRequired:
    setupLog("FrameOS upgrade: reboot required; services not restarted")
    return
  var services = @["frameos.service"]
  if remoteEnabled():
    services.add("frameos-remote.service")
  discard runSetupCommand(privilegedCommand("systemctl --no-block restart " & services.join(" ")), raiseOnError = false)

proc activateStagedRelease(staged: var StagedFrameOSRelease) =
  let previousFrameosCurrent = realPath(frameosInstallDir() / "current")
  let previousRemoteCurrent = realPath(frameosRemoteInstallDir() / "current")
  try:
    switchCurrentSymlink(frameosInstallDir() / "current", staged.frameosReleaseDir)
    switchCurrentSymlink(frameosRemoteInstallDir() / "current", staged.remoteReleaseDir)
    runStagedSetup(staged)
  except CatchableError:
    setupLog("FrameOS upgrade: activation failed; rolling back current symlinks")
    if previousFrameosCurrent.len > 0:
      switchCurrentSymlink(frameosInstallDir() / "current", previousFrameosCurrent)
    if previousRemoteCurrent.len > 0:
      switchCurrentSymlink(frameosRemoteInstallDir() / "current", previousRemoteCurrent)
    raise

proc statusPayload(status, message: string, release: FrameOSReleaseInfo, exitCode = 0): JsonNode =
  result = %*{
    "status": status,
    "message": message,
    "current_version": installedFrameOSVersion(),
    "compiled_version": compiledFrameOSVersion(),
    "target": release.target,
    "exit_code": exitCode,
  }
  if release.version.len > 0:
    result["latest_version"] = %release.version
    result["latest_release"] = releaseJson(release)

proc performFrameOSUpgrade*(options: FrameOSUpgradeOptions): JsonNode =
  var release = FrameOSReleaseInfo()
  try:
    let target = detectUpgradeTarget()
    release = latestFrameOSRelease(target)
    let currentVersion = installedFrameOSVersion()
    ensureCompatibleInstalledLayout(release)

    if currentVersion != "unknown" and compareFrameOSVersions(currentVersion, release.version) >= 0:
      result = statusPayload("up_to_date", "FrameOS is already on the latest stable GitHub release.", release)
      writeUpgradeStatus(result)
      setupLog(result["message"].getStr())
      return

    if options.dryRun:
      result = statusPayload(
        "dry_run",
        "FrameOS can be upgraded from " & currentVersion & " to " & release.version & " for " & release.target & ".",
        release,
      )
      result["update_available"] = %true
      writeUpgradeStatus(result)
      setupLog(result["message"].getStr())
      setupLog("FrameOS upgrade dry run: would download " & release.assetUrl)
      setupLog("FrameOS upgrade dry run: would stage a new release under " & frameosInstallDir() / "releases")
      return

    result = statusPayload("running", "FrameOS upgrade is running.", release)
    result["started_at"] = %nowIso()
    result["update_available"] = %true
    writeUpgradeStatus(result)

    var staged = stageFrameOSRelease(release)
    activateStagedRelease(staged)

    let rebootRequired = staged.setupStatus == 2
    result = statusPayload(
      if rebootRequired: "reboot_required" else: "success",
      if rebootRequired:
        "FrameOS upgraded to " & release.version & ". Reboot required before services restart."
      else:
        "FrameOS upgraded to " & release.version & ". Restarting services.",
      release,
    )
    result["release_dir"] = %staged.frameosReleaseDir
    result["remote_release_dir"] = %staged.remoteReleaseDir
    result["finished_at"] = %nowIso()
    result["update_available"] = %false
    writeUpgradeStatus(result)
    setupLog(result["message"].getStr())
    restartFrameOSServices(rebootRequired)
  except CatchableError as error:
    result = statusPayload("failed", error.msg, release, exitCode = 1)
    result["finished_at"] = %nowIso()
    writeUpgradeStatus(result)
    setupLog("FrameOS upgrade failed: " & error.msg)

proc runFrameOSUpgrade*(options: FrameOSUpgradeOptions): int =
  let payload = performFrameOSUpgrade(options)
  let status = payload{"status"}.getStr("")
  if status == "failed":
    return 1
  if status == "reboot_required":
    return 2
  0

proc parseFrameOSUpgradeOptions*(args: seq[string]): FrameOSUpgradeOptions =
  for arg in args:
    case arg
    of "--dry-run":
      result.dryRun = true
    of "--yes", "-y", "--non-interactive":
      result.yes = true
    else:
      raise newException(ValueError, "Unknown FrameOS upgrade option: " & arg)

proc scheduleFrameOSUpgrade*(): JsonNode =
  let binary = frameosInstallDir() / "current" / "frameos"
  if not fileExists(binary):
    raise newException(ValueError, "FrameOS binary not found: " & binary)
  createDir(frameosInstallDir() / "logs")
  let logPath = frameosInstallDir() / "logs" / "upgrade.log"
  writeUpgradeStatus(%*{
    "status": "starting",
    "message": "FrameOS upgrade has been queued.",
    "current_version": installedFrameOSVersion(),
    "compiled_version": compiledFrameOSVersion(),
    "log_path": logPath,
  })
  let childCommand = shellQuote(binary) & " upgrade --yes"
  let redirected = childCommand & " >> " & shellQuote(logPath) & " 2>&1"
  if commandExists("systemd-run"):
    discard runSetupCommand(privilegedCommand(
      "systemd-run --quiet --unit=frameos-upgrade --collect /bin/sh -lc " & shellQuote(redirected)
    ))
  else:
    discard runSetupCommand(privilegedCommand("sh -c " & shellQuote("nohup " & redirected & " &")))
  readUpgradeStatus()

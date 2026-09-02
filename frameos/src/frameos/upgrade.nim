import std/[base64, httpclient, json, os, strutils, tables, times]
import zippy

import frameos/cloud/identity
import frameos/config
import frameos/ota_pubkey
import frameos/utils/blake2b
import frameos/device_setup
from frameos/setup import frameosServiceContents, frameosServiceUser
import frameos/utils/http_client
import frameos/utils/process
import frameos/utils/system
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
  SupportedArches = ["arm64", "armhf", "armv6", "amd64"]
  MaxReleaseArchiveBytes = 512 * 1024 * 1024

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
    noReboot*: bool

  UpgradeFinishAction* = enum
    restartServices  ## the new release can take over in place
    rebootDevice     ## setup changed something only a boot re-reads
    stayPut          ## a reboot is needed but the caller asked us not to

  StagedFrameOSRelease* = object
    name*: string
    frameosReleaseDir*: string
    remoteReleaseDir*: string
    serviceUser*: string
    setupStatus*: int

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

const UpgradeTerminalStatuses* = ["success", "reboot_required", "failed", "up_to_date", "idle"]

proc upgradeStatusLogLine*(payload: JsonNode): JsonNode =
  ## The loggable view of upgrade-status.json.
  ##
  ## `frameos upgrade` runs detached, in a process that shares nothing with a
  ## running FrameOS but this file, so a cloud owner who pressed "Upgrade
  ## FrameOS" saw the request go out and then heard nothing — whether the
  ## device downloaded 40 MB, refused as already current, or died on an
  ## unsupported target. The cloud client watches the file and logs this.
  ##
  ## Only the fields worth a log line: the status file also carries the whole
  ## release JSON and a log path, which say nothing a person reading the log
  ## wants to know.
  let status =
    if payload != nil and payload.kind == JObject: payload{"status"}.getStr("idle")
    else: "idle"
  result = %*{"event": "cloud:upgrade", "status": status}
  if payload == nil or payload.kind != JObject:
    return
  for key in ["message", "current_version", "latest_version", "target", "exit_code"]:
    let value = payload{key}
    if value == nil or value.kind == JNull:
      continue
    if value.kind == JString and value.getStr("").len == 0:
      continue
    result[key] = value

proc upgradeStatusMtime*(): float =
  ## Unix mtime of upgrade-status.json, 0 when it does not exist. A stat, not
  ## a parse: the cloud client calls this on every watch tick.
  try:
    let path = frameosUpgradeStatusPath()
    if fileExists(path):
      return getLastModificationTime(path).toUnixFloat()
  except CatchableError:
    discard
  0.0

const UpgradeInFlightMaxAge = initDuration(hours = 2)

proc frameOSUpgradeInFlight*(): bool =
  ## True while the status file says an upgrade is queued or running, so a
  ## second trigger (a redelivered cloud nudge, a double-clicked button) is
  ## refused instead of clobbering the status of the one in flight. An
  ## upgrade that died without writing a terminal status must not wedge this
  ## forever: entries older than UpgradeInFlightMaxAge are disbelieved (the
  ## download alone is capped at 30 minutes).
  let payload = readUpgradeStatus()
  if payload{"status"}.getStr("") notin ["starting", "running"]:
    return false
  let updatedAt = payload{"updated_at"}.getStr("")
  if updatedAt.len == 0:
    return false
  try:
    let stamped = parse(updatedAt, "yyyy-MM-dd'T'HH:mm:ss'Z'", utc()).toTime()
    result = getTime() - stamped < UpgradeInFlightMaxAge
  except CatchableError:
    result = false

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

proc archForUname*(uname: string): string =
  case uname
  of "aarch64", "arm64", "armv8":
    "arm64"
  of "armv8l", "armv7l", "armhf":
    "armhf"
  # ARMv6 (Pi Zero W / Pi 1) must never fall back to armhf: those release
  # artifacts are built for ARMv7 and SIGILL on the ARM1176. Mirrors the
  # mapping in backend app/tasks/prebuilt_deps.py:resolve_prebuilt_target.
  of "armv6l", "armv6":
    "armv6"
  of "x86_64", "amd64":
    "amd64"
  else:
    raise newException(ValueError, "Unsupported CPU architecture: " & uname & ". Supported architectures: " & SupportedArches.join(", "))

proc detectArch(): string =
  let overrideArch = getEnv("FRAMEOS_ARCH_OVERRIDE").strip()
  if overrideArch.len > 0:
    return overrideArch
  let uname = runShellCapture("uname -m", timeoutMs = 5000, maxOutputBytes = 4096).output.strip().splitLines()[0]
  archForUname(uname)

proc normalizeDistroRelease*(values: Table[string, string]): tuple[distro, release: string] =
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
  elif result.distro == "buildroot":
    # Buildroot images ship the Debian Bookworm precompiled FrameOS artifact;
    # the os-release VERSION_ID is the Buildroot version, not a binary target.
    result.distro = "debian"
    result.release = "bookworm"
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

proc releaseSignatureUrl*(assetUrl: string): string =
  assetUrl & ".minisig"

proc parseMinisigSignature*(minisig: string): string =
  ## The first non-comment line of a .minisig is base64(ED + keyid8 + sig64).
  ## Returns the 64-byte signature, base64 encoded for the Ed25519 verifier.
  ##
  ## The trusted-comment line and its global signature are ignored on purpose:
  ## the device trusts a KEY, not a comment, and minisign's global signature
  ## only binds the comment to the signature — it adds nothing once the key
  ## check below has passed. Same reasoning as parse_minisig in
  ## embedded/esp32/main/fos_ota.c, which this mirrors deliberately: two
  ## implementations of one format should be readable side by side.
  for rawLine in minisig.splitLines():
    let line = rawLine.strip()
    if line.len == 0 or line.startsWith("untrusted comment:") or
        line.startsWith("trusted comment:"):
      continue
    var blob: string
    try:
      blob = decode(line)
    except CatchableError:
      raise newException(ValueError, "Release signature is not valid base64")
    if blob.len != 74:
      raise newException(ValueError,
        "Release signature blob has the wrong length (" & $blob.len & ", expected 74)")
    if blob[0] != 'E' or blob[1] != 'D':
      raise newException(ValueError,
        "Release signature is not the prehashed Ed25519 form this build accepts")
    var keyIdHex = ""
    for i in 2 ..< 10:
      keyIdHex.add(toHex(ord(blob[i]), 2).toLowerAscii)
    if keyIdHex != OtaSigningKeyIdHex:
      raise newException(ValueError,
        "Release is signed by key " & keyIdHex & ", not the key this build trusts (" &
        OtaSigningKeyIdHex & ")")
    return encode(blob[10 ..< 74])
  raise newException(ValueError, "Release signature file contained no signature line")

proc verifyReleaseArchiveSignature*(archivePath, minisig: string) =
  ## Refuses to go further unless the archive was signed by the release key
  ## baked into this build (ota_pubkey.nim).
  ##
  ## This is the whole point of signed OTA: the update channel must not become
  ## remote code execution if the control plane is compromised. The provider
  ## says which version exists and where to get it; only this check decides
  ## whether the bytes are run, and it depends on nothing the provider
  ## controls. minisign prehashes with BLAKE2b-512 and signs the digest, so
  ## that digest is the message verified here.
  let signatureBase64 = parseMinisigSignature(minisig)
  let digest = blake2b512File(archivePath)
  if not verifySignatureBase64(OtaSigningPublicKeyBase64, digest, signatureBase64):
    raise newException(ValueError,
      "Release signature does not verify against the FrameOS signing key — refusing to install " &
      archivePath)

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
  if mode notin ["rpios", "buildroot"]:
    raise newException(ValueError, "FrameOS upgrade supports installed Raspberry Pi OS and Buildroot frames only; current mode is " & mode)
  if not commandExists("systemctl"):
    raise newException(ValueError, "FrameOS upgrade requires systemd/systemctl")
  if not commandExists("tar"):
    raise newException(ValueError, "FrameOS upgrade requires tar")
  if not commandSucceeds("test \"$(id -u)\" = 0 || sudo -n true >/dev/null 2>&1"):
    raise newException(ValueError, "FrameOS upgrade must run as root or with passwordless sudo")
  discard release

proc downloadReleaseArchive*(release: FrameOSReleaseInfo, destination: string) =
  ## Streamed to disk by the binary's own bounded TLS client — the same
  ## client that just fetched the release metadata and is about to fetch the
  ## signature, so a device that got this far can by construction download
  ## the archive too.
  ##
  ## Deliberately NO curl and NO wget. Picking a downloader by `command -v`
  ## is how every buildroot cloud upgrade died: busybox provides a `wget`
  ## applet, so the probe said yes — but it is built without TLS and refuses
  ## any https URL ("wget: not an http or ftp url"), while the built-in
  ## client sat unused in the fallback branch. A downloader the binary
  ## carries itself cannot be absent, misbuilt, or shadowed on the device,
  ## and the byte/time bounds, redirect policy and partial-file cleanup are
  ## one audited code path instead of three.
  validateGithubReleaseAssetUrl(release.assetUrl, release.version)
  boundedDownloadToFile(
    release.assetUrl,
    destination,
    timeoutMs = 60_000,
    maxBytes = MaxReleaseArchiveBytes,
    maxSeconds = 1800,
    headers = @[("User-Agent", "FrameOS/" & compiledFrameOSVersion())],
  )

# Test seams for stageFrameOSRelease's two network fetches. nil = the real
# downloader. They exist so the SECURITY-CRITICAL property of the staging
# flow — the signature is verified before tar touches the archive — can be
# pinned by an offline test; the fetchers themselves are covered separately
# (boundedDownloadToFile in test_http_client, the crypto in test_upgrade).
type
  ReleaseArchiveFetcher* = proc(release: FrameOSReleaseInfo, destination: string)
  ReleaseSignatureFetcher* = proc(release: FrameOSReleaseInfo): string

var releaseArchiveFetcher: ReleaseArchiveFetcher = nil
var releaseSignatureFetcher: ReleaseSignatureFetcher = nil

proc setReleaseFetchersForTest*(archive: ReleaseArchiveFetcher,
                                signature: ReleaseSignatureFetcher) =
  releaseArchiveFetcher = archive
  releaseSignatureFetcher = signature

proc resetReleaseFetchersForTest*() =
  releaseArchiveFetcher = nil
  releaseSignatureFetcher = nil

proc downloadReleaseSignature(release: FrameOSReleaseInfo): string =
  ## The .minisig beside the asset. Small (a few hundred bytes), so it is
  ## fetched into memory rather than staged on disk.
  let url = releaseSignatureUrl(release.assetUrl)
  validateGithubReleaseAssetUrl(release.assetUrl, release.version)
  var headers = newHttpHeaders()
  headers["User-Agent"] = "FrameOS/" & compiledFrameOSVersion()
  boundedGetContent(url, headers = headers, timeoutMs = 30_000,
                    maxBytes = 8 * 1024, maxSeconds = 60)

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
  writePrivateFile(destination, pretty(payload, indent = 4) & "\n")

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

proc copyFirstExistingFile(sources: openArray[string], destination: string) =
  for source in sources:
    if fileExists(source):
      copyFile(source, destination)
      return

const ReleaseExtractSpaceFactor* = 2
  ## Free bytes an extraction needs, as a multiple of the .tar.gz size: the
  ## unpacked binaries plus their copies into the release directories.

proc releaseSpaceShortfall*(archiveBytes, availableBytes: int64): int64 =
  ## How many bytes short `availableBytes` is of unpacking an archive of
  ## `archiveBytes`; 0 when it fits, and 0 when the free space is unknown
  ## (-1 from getAvailableDiskSpace — a filesystem statvfs cannot answer for
  ## is not a reason to refuse an upgrade).
  if availableBytes < 0 or archiveBytes <= 0:
    return 0
  let needed = archiveBytes * ReleaseExtractSpaceFactor
  if availableBytes >= needed: 0 else: needed - availableBytes

proc ensureFreeSpaceForRelease(archivePath: string, dirs: openArray[string]) =
  ## Refuse before tar starts: a full SD card mid-extraction leaves a half
  ## release and, on Buildroot's data partition, a frame that cannot even
  ## log why. Both the scratch dir and the releases dir are checked because
  ## on Raspberry Pi OS they are different filesystems (/tmp vs /srv).
  let archiveBytes = getFileSize(archivePath)
  for dir in dirs:
    let available = getAvailableDiskSpace(dir)
    let shortfall = releaseSpaceShortfall(archiveBytes, available)
    if shortfall > 0:
      raise newException(ValueError,
        "Not enough free disk space in " & dir & " to unpack the release: " &
        $(archiveBytes * ReleaseExtractSpaceFactor) & " bytes needed (archive " &
        $archiveBytes & " x" & $ReleaseExtractSpaceFactor & "), " & $available &
        " available, short by " & $shortfall)

proc stageFrameOSRelease*(release: FrameOSReleaseInfo): StagedFrameOSRelease =
  let timestamp = format(now(), "yyyyMMddHHmmss")
  result.name = "release_upgrade_" & timestamp & "_" & release.version.replace(".", "_")
  result.frameosReleaseDir = frameosInstallDir() / "releases" / result.name
  result.remoteReleaseDir = frameosRemoteInstallDir() / "releases" / result.name
  if dirExists(result.frameosReleaseDir) or dirExists(result.remoteReleaseDir):
    raise newException(ValueError, "Release directory already exists: " & result.name)

  let mode = currentFrameConfig(){"mode"}.getStr("rpios")
  # /tmp is a small tmpfs on Buildroot; stage the download and extraction on
  # the SD-backed data partition instead of RAM.
  let workBase = if mode == "buildroot": frameosInstallDir() / "tmp" else: getTempDir()
  let workDir = workBase / ("frameos-upgrade-" & $getCurrentProcessId() & "-" & timestamp)
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
    if releaseArchiveFetcher.isNil:
      downloadReleaseArchive(release, workDir / "frameos.tar.gz")
    else:
      releaseArchiveFetcher(release, workDir / "frameos.tar.gz")

    # Verify BEFORE unpacking: `tar -xzf` on an unverified archive is already
    # letting an attacker choose file contents and paths on this device. The
    # signature is checked against the key compiled into this binary, so a
    # compromised provider (or a hijacked download) cannot get code executed
    # here — it can only offer bytes that fail this check.
    setupLog("FrameOS upgrade: verifying the release signature")
    let minisig =
      if releaseSignatureFetcher.isNil: downloadReleaseSignature(release)
      else: releaseSignatureFetcher(release)
    verifyReleaseArchiveSignature(workDir / "frameos.tar.gz", minisig)
    setupLog("FrameOS upgrade: signature OK (key " & OtaSigningKeyIdHex & ")")

    ensureFreeSpaceForRelease(workDir / "frameos.tar.gz",
      [workDir, frameosInstallDir() / "releases"])
    # Extraction runs as root: without these two flags GNU tar restores the
    # archive's uid/gid and mode bits verbatim, so a release built by a CI
    # user (or a setuid bit in the tarball) would land as-is. Both the
    # Raspberry Pi OS and the Buildroot images ship GNU tar
    # (BR2_PACKAGE_TAR=y), which accepts both long options.
    discard runSetupCommand("tar --no-same-owner --no-same-permissions -xzf " &
      shellQuote(workDir / "frameos.tar.gz") & " -C " & shellQuote(workDir / "extract"))

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
    # No `scenes/` any more: release archives never carried scene `.so`s, and
    # the modes that built them are gone. The stale `current/scenes` entry in
    # LD_LIBRARY_PATH stays — a directory that does not exist costs a linker
    # nothing, and rewriting it would rewrite the installed unit (and the
    # published base images' hashes) for no gain.
    if dirExists(artifactRoot / "vendor"):
      createDir(frameosInstallDir() / "vendor")
      discard runSetupCommand("cp -R " & shellQuote(artifactRoot / "vendor" / ".") & " " & shellQuote(frameosInstallDir() / "vendor" / ""))

    let oldReleaseDir = realPath(frameosInstallDir() / "current")
    let oldRemoteReleaseDir = realPath(frameosRemoteInstallDir() / "current")
    writeFrameConfigForUpgrade(currentFrameConfigPath(), result.frameosReleaseDir / "frame.json", release.version)
    copyFile(result.frameosReleaseDir / "frame.json", result.remoteReleaseDir / "frame.json")
    setFilePermissions(result.remoteReleaseDir / "frame.json", {fpUserRead, fpUserWrite})
    copyScenePayloads(result.frameosReleaseDir, oldReleaseDir)

    copyAdminSessionSaltForUpgrade(result.frameosReleaseDir)

    let serviceUser = serviceUserFromFile("/etc/systemd/system/frameos.service")
    result.serviceUser = serviceUser
    if mode == "buildroot":
      # Buildroot service files carry image-specific settings (User=root,
      # FRAMEOS_HOME and LD_LIBRARY_PATH pointing into the release); carry them
      # over instead of generating the Raspberry Pi OS variants.
      #
      # The INSTALLED unit is the source of truth, not the release directory's
      # copy: images built before this was fixed staged the two from different
      # renderers, and the release copy is missing the NetworkManager
      # Wants=/After= lines that the installed one has. Preferring the release
      # copy made the upgrade rewrite /etc/systemd/system/frameos.service on
      # every single run — a write the read-only Buildroot rootfs refuses, and
      # a needless downgrade of the unit even where it succeeds.
      copyFirstExistingFile(
        ["/etc/systemd/system/frameos.service", oldReleaseDir / "frameos.service"],
        result.frameosReleaseDir / "frameos.service",
      )
      copyFirstExistingFile(
        ["/etc/systemd/system/frameos-remote.service", oldRemoteReleaseDir / "frameos-remote.service"],
        result.remoteReleaseDir / "frameos-remote.service",
      )
    if not fileExists(result.frameosReleaseDir / "frameos.service"):
      writeFile(
        result.frameosReleaseDir / "frameos.service",
        frameosServiceContents(serviceUser, framebufferConsole = currentFrameConfig(){"device"}.getStr("") == "framebuffer"),
      )
    if not fileExists(result.remoteReleaseDir / "frameos-remote.service"):
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

proc upgradeFinishAction*(rebootRequired, mayReboot: bool): UpgradeFinishAction =
  ## How a staged-and-activated release is put into service.
  ##
  ## `setup` exits 2 when it changed something only a boot re-reads (kernel
  ## cmdline, boot config). The new release is already `current` by then, so
  ## doing nothing leaves the frame running the old binary until somebody
  ## power-cycles it — which, on a frame hanging on a wall halfway around the
  ## world, may be never. Nobody is standing there to press reset, so an
  ## unattended upgrade finishes itself.
  if not rebootRequired:
    return restartServices
  if mayReboot: rebootDevice else: stayPut

proc finishFrameOSUpgrade(action: UpgradeFinishAction) =
  case action
  of stayPut:
    setupLog("FrameOS upgrade: reboot required; --no-reboot given, services not restarted")
  of rebootDevice:
    # The delay is generous on purpose: the cloud hub polls upgrade-status.json
    # every 5s and batches log lines, so this buys the owner the final status
    # line before the link goes down.
    setupLog("FrameOS upgrade: reboot required; rebooting")
    scheduleSystemReboot(10)
  of restartServices:
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
    let finishAction = upgradeFinishAction(rebootRequired, mayReboot = not options.noReboot)
    result = statusPayload(
      if rebootRequired: "reboot_required" else: "success",
      if finishAction == rebootDevice:
        "FrameOS upgraded to " & release.version & ". Rebooting to finish."
      elif rebootRequired:
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
    finishFrameOSUpgrade(finishAction)
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
    of "--no-reboot":
      result.noReboot = true
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

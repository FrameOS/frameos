import std/[base64, httpclient, json, os, sequtils, strutils, tables, times]
import zippy

import frameos/buildroot_privileges
import frameos/cloud/identity
import frameos/config
import frameos/ota_pubkey
import frameos/privileged
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
  writeFileAtomically(frameosUpgradeStatusPath(), pretty(payload, indent = 2) & "\n")

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

const UpgradeInterruptedMinAge = initDuration(minutes = 10)

proc reconcileInterruptedUpgradeStatus*(): bool =
  ## Called once at runtime start. The restart that brings a runtime up is
  ## normally the *last* thing an upgrade does, after it wrote "success", so a
  ## status still "starting"/"running" here belongs to an upgrade process that
  ## died without a verdict — Cloud-5 (2026-09-04) sat on "running" for hours
  ## after its upgrade child was killed mid-setup, and the workspace kept
  ## reporting an upgrade in progress. Only entries older than ten minutes
  ## are rewritten (to "failed", keeping the release details), so a runtime
  ## that crashed while a detached root-path upgrade is still downloading
  ## does not lie about it. Returns true when it rewrote the file.
  let payload = readUpgradeStatus()
  let status = payload{"status"}.getStr("")
  if status notin ["starting", "running"]:
    return false
  let updatedAt = payload{"updated_at"}.getStr("")
  var stale = updatedAt.len == 0
  if not stale:
    try:
      let stamped = parse(updatedAt, "yyyy-MM-dd'T'HH:mm:ss'Z'", utc()).toTime()
      stale = getTime() - stamped >= UpgradeInterruptedMinAge
    except CatchableError:
      stale = true
  if not stale:
    return false
  var updated = payload.copy()
  updated["status"] = %"failed"
  updated["message"] = %("FrameOS upgrade was interrupted before it finished (status '" & status &
    "' since " & (if updatedAt.len > 0: updatedAt else: "an unknown time") & ").")
  updated["interrupted"] = %true
  writeUpgradeStatus(updated)
  true

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

proc isBuildrootHost*(osReleasePath = "/etc/os-release"): bool =
  ## The root-owned host identity is the trust anchor for the root worker.
  ## frame.json is writable by the runtime and must never be allowed to make
  ## a Buildroot host execute the broader Raspberry Pi OS setup path.
  parseOsRelease(osReleasePath).getOrDefault("ID", "").toLowerAscii() == "buildroot"

proc privilegedBuildrootContextProblem*(configuredMode: string,
                                        osReleasePath = "/etc/os-release"): string =
  if not isBuildrootHost(osReleasePath):
    return "the privileged worker is only available on a Buildroot host"
  if configuredMode != "buildroot":
    return "the installed frame config mode must be buildroot"
  ""

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

proc releaseInstallVersionProblem*(currentVersion, requestedVersion: string): string =
  if not validReleaseVersion(requestedVersion):
    return "release version must have exactly three numeric fields (YYYY.M.N)"
  let current = normalizeReleaseVersion(currentVersion)
  if current != "unknown" and compareFrameOSVersions(current, requestedVersion) >= 0:
    return "release " & requestedVersion & " is not newer than installed FrameOS " & current
  ""

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
  if not privilegedDoorAvailable() and
      not commandSucceeds("test \"$(id -u)\" = 0 || sudo -n true >/dev/null 2>&1"):
    raise newException(ValueError,
      "FrameOS upgrade must run as root, with passwordless sudo, or behind the privileged door")
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

const
  ## The files an upgrade carries over from the old release directory belong
  ## to the runtime user on a Buildroot frame, and the release directory is
  ## sticky-writable for it. Root copies them, and hands the copies back to
  ## the runtime — so a symlink (or a hard link) the runtime planted under one
  ## of these names would turn the copy into "root reads any file for me".
  ## `readFileNoFollow` refuses both; these caps bound what root will read.
  MaxCarriedPayloadBytes = 64 * 1024 * 1024
  MaxCarriedSaltBytes = 4 * 1024

proc readCarriedRuntimeFile*(path: string, maxBytes = MaxCarriedPayloadBytes): string =
  ## A runtime-owned file the upgrade copies forward, read without following
  ## symlinks or hard links (utils/system.readFileNoFollow). Exported for the
  ## tests; every carry-over below goes through it.
  readFileNoFollow(path, maxBytes)

proc copyCompressedPayload(releaseDir, oldDir, compressedName, plainName: string) =
  if oldDir.len > 0 and fileExists(oldDir / compressedName):
    writeFile(releaseDir / compressedName, readCarriedRuntimeFile(oldDir / compressedName))
  elif oldDir.len > 0 and fileExists(oldDir / plainName):
    writeFile(releaseDir / compressedName, compress(readCarriedRuntimeFile(oldDir / plainName), dataFormat = dfGzip))
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
    writePrivateFile(targetSalt, readCarriedRuntimeFile(sharedSalt, MaxCarriedSaltBytes))
  elif fileExists(legacySalt):
    writePrivateFile(targetSalt, readCarriedRuntimeFile(legacySalt, MaxCarriedSaltBytes))

proc writeFrameConfigForUpgrade(configPath, destination, version: string) =
  var payload = parseJson(readCarriedRuntimeFile(configPath))
  if payload.kind != JObject:
    raise newException(ValueError, "Current frame config is not a JSON object: " & configPath)
  payload["frameosVersion"] = %version
  writePrivateFile(destination, pretty(payload, indent = 4) & "\n")

proc serviceUserFromFile(path: string): string =
  let installed = installedServiceUser(path)
  if installed.len > 0:
    return installed
  frameosServiceUser()

proc buildrootRemoteInstalled*(): bool =
  ## Generic Buildroot images no longer ship FrameOS Remote at all
  ## (docs/buildroot-privileges.md §2): no /srv/frameos/remote, no unit. An
  ## upgrade only carries the remote forward where an image (or a backend
  ## deploy) put it in the first place.
  dirExists(frameosRemoteInstallDir() / "current") or
    fileExists("/etc/systemd/system/frameos-remote.service")

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

proc newStagedReleaseName(release: FrameOSReleaseInfo, timestamp: string): string =
  "release_upgrade_" & timestamp & "_" & release.version.replace(".", "_")

proc expectedReleaseArchiveRootName*(release: FrameOSReleaseInfo): string =
  "frameos-" & release.version & "-" & release.target

proc extractedReleaseRoot*(extractDir: string, release: FrameOSReleaseInfo): string =
  ## Bind the signed bytes to the requested version and detected target. A
  ## signature proves an archive is an official FrameOS artifact, but without
  ## this name check an untrusted runtime could label any older signed archive
  ## as the requested release and have root install and execute it.
  result = extractDir / expectedReleaseArchiveRootName(release)
  if not dirExists(result) or symlinkExists(result):
    raise newException(ValueError, "The signed release archive did not contain the expected root " &
      expectedReleaseArchiveRootName(release))
  for _, path in walkDir(extractDir):
    if path != result:
      raise newException(ValueError, "The signed release archive contained an unexpected top-level entry: " &
        lastPathPart(path))

proc assembleReleaseFromArchive(release: FrameOSReleaseInfo, archivePath, workDir: string,
                                staged: var StagedFrameOSRelease) =
  ## Everything after the signature check: unpack, lay out the release
  ## directories, carry the frame's config and scene payloads over, and
  ## settle ownership. `archivePath` must already be verified — this proc
  ## trusts it, so callers verify before calling (both do).
  let configuredMode = currentFrameConfig(){"mode"}.getStr("rpios")
  if isBuildrootHost() and configuredMode != "buildroot":
    raise newException(ValueError, privilegedBuildrootContextProblem(configuredMode))
  let mode = if isBuildrootHost(): "buildroot" else: configuredMode
  let withRemote = mode != "buildroot" or buildrootRemoteInstalled()
  createDir(workDir / "extract")
  createDir(staged.frameosReleaseDir)
  if withRemote:
    createDir(staged.remoteReleaseDir)
    createDir(frameosRemoteInstallDir() / "logs")
  createDir(frameosInstallDir() / "logs")
  createDir(frameosStateDir())
  createDir(frameosAssetsDir())

  ensureFreeSpaceForRelease(archivePath, [workDir, frameosInstallDir() / "releases"])
  # Extraction can run as root: never restore archive-supplied ownership or
  # special mode bits even though the release signature is valid.
  discard runSetupCommand("tar --no-same-owner --no-same-permissions -xzf " &
    shellQuote(archivePath) & " -C " & shellQuote(workDir / "extract"))

  let artifactRoot = extractedReleaseRoot(workDir / "extract", release)
  let frameosBinary = findFileNamed(artifactRoot, "frameos")
  var remoteBinary = findFileNamed(artifactRoot, "frameos_remote")
  if remoteBinary.len == 0:
    remoteBinary = findFileNamed(artifactRoot, "frameos_agent")
  if frameosBinary.len == 0:
    raise newException(ValueError, "The FrameOS release did not contain a frameos binary for " & release.target)
  if withRemote and remoteBinary.len == 0:
    raise newException(ValueError, "The FrameOS release did not contain a frameos_remote binary for " & release.target)

  discard runSetupCommand("install -m 0755 " & shellQuote(frameosBinary) & " " & shellQuote(staged.frameosReleaseDir / "frameos"))
  if withRemote:
    discard runSetupCommand("install -m 0755 " & shellQuote(remoteBinary) & " " & shellQuote(staged.remoteReleaseDir / "frameos_remote"))

  copyDirIfExists(artifactRoot / "drivers", staged.frameosReleaseDir / "drivers")
  # These are roots from which privileged processes may load code. Pre-create
  # them while the release is root-only, before Buildroot's sticky release
  # ownership is applied, so the runtime cannot plant either directory.
  createDir(staged.frameosReleaseDir / "drivers")
  createDir(staged.frameosReleaseDir / "scenes")
  if dirExists(artifactRoot / "vendor"):
    createDir(frameosInstallDir() / "vendor")
    discard runSetupCommand("cp -R " & shellQuote(artifactRoot / "vendor" / ".") & " " & shellQuote(frameosInstallDir() / "vendor" / ""))

  let oldReleaseDir = realPath(frameosInstallDir() / "current")
  let oldRemoteReleaseDir = realPath(frameosRemoteInstallDir() / "current")
  writeFrameConfigForUpgrade(currentFrameConfigPath(), staged.frameosReleaseDir / "frame.json", release.version)
  if withRemote:
    copyFile(staged.frameosReleaseDir / "frame.json", staged.remoteReleaseDir / "frame.json")
    setFilePermissions(staged.remoteReleaseDir / "frame.json", {fpUserRead, fpUserWrite})
  copyScenePayloads(staged.frameosReleaseDir, oldReleaseDir)

  copyAdminSessionSaltForUpgrade(staged.frameosReleaseDir)

  let serviceUser = serviceUserFromFile("/etc/systemd/system/frameos.service")
  staged.serviceUser = serviceUser
  if mode == "buildroot":
    # Buildroot units are rendered by `frameos setup` from the template in
    # this binary (buildroot_privileges.nim); the copy in the release
    # directory only exists for older code that copied it. Stage the
    # rendering setup is about to install so the two agree.
    let user = buildrootServiceUser(loadConfig(staged.frameosReleaseDir / "frame.json"),
                                    serviceUser, buildrootUsesNetworkManager())
    writeFile(staged.frameosReleaseDir / "frameos.service",
              renderBuildrootFrameosService(user, buildrootUsesNetworkManager()))
    if withRemote:
      copyFirstExistingFile(
        ["/etc/systemd/system/frameos-remote.service", oldRemoteReleaseDir / "frameos-remote.service"],
        staged.remoteReleaseDir / "frameos-remote.service",
      )
  if not fileExists(staged.frameosReleaseDir / "frameos.service"):
    writeFile(
      staged.frameosReleaseDir / "frameos.service",
      frameosServiceContents(serviceUser, framebufferConsole = currentFrameConfig(){"device"}.getStr("") == "framebuffer"),
    )
  if withRemote and not fileExists(staged.remoteReleaseDir / "frameos-remote.service"):
    writeFile(staged.remoteReleaseDir / "frameos-remote.service", remoteServiceContents(serviceUser))

  if mode == "buildroot" and runningAsRoot():
    # Root owns the code, the runtime user owns its state; `frameos setup`
    # repeats this after activation, but the release directory must be
    # right before the new binary is first executed.
    applyBuildrootOwnership(
      buildrootServiceUser(loadConfig(staged.frameosReleaseDir / "frame.json"), serviceUser,
                           buildrootUsesNetworkManager()),
      frameosInstallDir())
  else:
    var chownTargets = @[staged.frameosReleaseDir, frameosStateDir(), frameosInstallDir() / "logs", frameosAssetsDir()]
    if withRemote:
      chownTargets.add(staged.remoteReleaseDir)
      chownTargets.add(frameosRemoteInstallDir() / "logs")
    discard runSetupCommand(
      privilegedCommand(
        "chown -R " & shellQuote(serviceUser) & " " & chownTargets.mapIt(shellQuote(it)).join(" ")
      ),
      raiseOnError = false,
    )

proc upgradeWorkBase(mode: string): string =
  ## /tmp is a small tmpfs on Buildroot; stage the download and extraction on
  ## the SD-backed data partition instead of RAM.
  if mode == "buildroot": frameosInstallDir() / "tmp" else: getTempDir()

proc stageFrameOSRelease*(release: FrameOSReleaseInfo): StagedFrameOSRelease =
  ## The root path: download, verify, unpack and lay out the release.
  let timestamp = format(now(), "yyyyMMddHHmmss")
  result.name = newStagedReleaseName(release, timestamp)
  result.frameosReleaseDir = frameosInstallDir() / "releases" / result.name
  result.remoteReleaseDir = frameosRemoteInstallDir() / "releases" / result.name
  if dirExists(result.frameosReleaseDir) or dirExists(result.remoteReleaseDir):
    raise newException(ValueError, "Release directory already exists: " & result.name)

  let mode = currentFrameConfig(){"mode"}.getStr("rpios")
  let workDir = upgradeWorkBase(mode) / ("frameos-upgrade-" & $getCurrentProcessId() & "-" & timestamp)
  try:
    createDir(workDir)

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

    assembleReleaseFromArchive(release, workDir / "frameos.tar.gz", workDir, result)
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
  config{"agent"}{"agentEnabled"}.getBool(false) and
    (config{"mode"}.getStr("rpios") != "buildroot" or buildrootRemoteInstalled())

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
  let withRemote = dirExists(staged.remoteReleaseDir)
  let previousFrameosCurrent = realPath(frameosInstallDir() / "current")
  let previousRemoteCurrent = if withRemote: realPath(frameosRemoteInstallDir() / "current") else: ""
  try:
    switchCurrentSymlink(frameosInstallDir() / "current", staged.frameosReleaseDir)
    if withRemote:
      switchCurrentSymlink(frameosRemoteInstallDir() / "current", staged.remoteReleaseDir)
    runStagedSetup(staged)
  except CatchableError:
    setupLog("FrameOS upgrade: activation failed; rolling back current symlinks")
    if previousFrameosCurrent.len > 0:
      switchCurrentSymlink(frameosInstallDir() / "current", previousFrameosCurrent)
    if withRemote and previousRemoteCurrent.len > 0:
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

proc releaseInfoForVersion(version: string): FrameOSReleaseInfo =
  ## What install-release knows about the archive it was handed: the version
  ## the caller claims (it is re-checked against frameos.service's needs only
  ## by the signature — a signed archive of any version is a genuine release)
  ## and this device's target.
  result.version = normalizeReleaseVersion(version)
  result.tagName = "v" & result.version
  result.target = detectUpgradeTarget()
  result.assetName = "frameos-" & result.version & "-" & result.target & ".tar.gz"

proc stagedArchiveInsideStagingDir(archivePath: string): bool =
  ## The worker only accepts a regular file directly inside a staging
  ## sub-directory the unprivileged upgrade created; symlinks anywhere on
  ## the path are refused so the runtime cannot point root at another file.
  let stagingDir = privilegedStagingDir(frameosInstallDir())
  if not archivePath.startsWith(stagingDir & "/"):
    return false
  if symlinkExists(archivePath) or not fileExists(archivePath):
    return false
  var dir = parentDir(archivePath)
  while dir.len > stagingDir.len:
    if symlinkExists(dir):
      return false
    dir = parentDir(dir)
  true

proc installStagedReleaseArchive*(archivePath, minisig, version: string): JsonNode =
  ## Root side of the privileged door's `install-release` verb: the second
  ## half of an upgrade whose first half — download and signature check —
  ## ran as the `frameos` user. Copies the archive somewhere the runtime
  ## cannot touch, verifies the minisign signature AGAIN against the key in
  ## this binary (root trusts nothing the runtime says about the bytes),
  ## unpacks, activates, runs setup and restarts or reboots. Writes
  ## upgrade-status.json throughout, exactly like performFrameOSUpgrade,
  ## because the runtime that asked may be restarted before it can.
  var release = FrameOSReleaseInfo()
  try:
    if not runningAsRoot():
      raise newException(ValueError, "install-release must run as root")
    let contextProblem = privilegedBuildrootContextProblem(
      currentFrameConfig(){"mode"}.getStr(""))
    if contextProblem.len > 0:
      raise newException(ValueError, contextProblem)
    let versionProblem = releaseInstallVersionProblem(installedFrameOSVersion(), version)
    if versionProblem.len > 0:
      raise newException(ValueError, versionProblem)
    release = releaseInfoForVersion(version)
    if not stagedArchiveInsideStagingDir(archivePath):
      raise newException(ValueError, "Refusing to install an archive outside " &
        privilegedStagingDir(frameosInstallDir()) & ": " & archivePath)
    if getFileSize(archivePath) > MaxReleaseArchiveBytes:
      raise newException(ValueError, "Staged release archive is larger than " & $MaxReleaseArchiveBytes & " bytes")
    ensureCompatibleInstalledLayout(release)

    let timestamp = format(now(), "yyyyMMddHHmmss")
    var staged = StagedFrameOSRelease()
    staged.name = newStagedReleaseName(release, timestamp)
    staged.frameosReleaseDir = frameosInstallDir() / "releases" / staged.name
    staged.remoteReleaseDir = frameosRemoteInstallDir() / "releases" / staged.name
    if dirExists(staged.frameosReleaseDir) or dirExists(staged.remoteReleaseDir):
      raise newException(ValueError, "Release directory already exists: " & staged.name)

    result = statusPayload("running", "FrameOS is installing the staged release " & release.version & ".", release)
    result["started_at"] = %nowIso()
    writeUpgradeStatus(result)

    # Root-owned work directory (0700) on the same partition: the copy is
    # what gets verified and unpacked, so a runtime that swaps the staged
    # file after handing it over changes nothing.
    let workDir = frameosInstallDir() / "releases" / (".install-" & timestamp)
    try:
      createDir(workDir)
      setFilePermissions(workDir, {fpUserRead, fpUserWrite, fpUserExec})
      copyFileNoFollow(archivePath, workDir / "frameos.tar.gz", MaxReleaseArchiveBytes)
      setupLog("FrameOS upgrade: verifying the staged release signature as root")
      verifyReleaseArchiveSignature(workDir / "frameos.tar.gz", minisig)
      setupLog("FrameOS upgrade: signature OK (key " & OtaSigningKeyIdHex & ")")
      assembleReleaseFromArchive(release, workDir / "frameos.tar.gz", workDir, staged)
    finally:
      if dirExists(workDir):
        removeDir(workDir)
      try:
        removeDir(parentDir(archivePath))
      except CatchableError:
        discard

    activateStagedRelease(staged)

    let rebootRequired = staged.setupStatus == 2
    let finishAction = upgradeFinishAction(rebootRequired, mayReboot = true)
    result = statusPayload(
      if rebootRequired: "reboot_required" else: "success",
      if finishAction == rebootDevice:
        "FrameOS upgraded to " & release.version & ". Rebooting to finish."
      else:
        "FrameOS upgraded to " & release.version & ". Restarting services.",
      release,
    )
    result["release_dir"] = %staged.frameosReleaseDir
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

proc performFrameOSUpgradeThroughDoor(release: FrameOSReleaseInfo): JsonNode =
  ## The unprivileged half: fetch and verify as the runtime user, then ask
  ## root to install. The worker owns upgrade-status.json from the moment it
  ## accepts the request; this side only records the outcome if it is still
  ## alive to see one (a successful install restarts frameos.service, which
  ## takes this process with it).
  let timestamp = format(now(), "yyyyMMddHHmmss")
  let stagingDir = privilegedStagingDir(frameosInstallDir()) / ("frameos-upgrade-" & timestamp)
  createDir(stagingDir)
  let archivePath = stagingDir / "frameos.tar.gz"
  try:
    setupLog("FrameOS upgrade: downloading " & release.assetName)
    if releaseArchiveFetcher.isNil:
      downloadReleaseArchive(release, archivePath)
    else:
      releaseArchiveFetcher(release, archivePath)
    setupLog("FrameOS upgrade: verifying the release signature")
    let minisig =
      if releaseSignatureFetcher.isNil: downloadReleaseSignature(release)
      else: releaseSignatureFetcher(release)
    verifyReleaseArchiveSignature(archivePath, minisig)
    setupLog("FrameOS upgrade: signature OK (key " & OtaSigningKeyIdHex & "); asking the privileged door to install")
    let res = requestPrivileged(pvInstallRelease, %*{
      "archive": archivePath,
      "signature": minisig,
      "version": release.version,
    }, timeoutMs = 30 * 60 * 1000, pollMs = 500)
    if res.data != nil and res.data.kind == JObject and res.data.hasKey("status"):
      result = res.data
    elif res.ok:
      result = statusPayload("success", "FrameOS upgraded to " & release.version & ".", release)
    else:
      result = statusPayload("failed", res.error, release, exitCode = max(res.exitCode, 1))
      result["finished_at"] = %nowIso()
      writeUpgradeStatus(result)
      setupLog("FrameOS upgrade failed: " & res.error)
  finally:
    if dirExists(stagingDir):
      removeDir(stagingDir)

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

    if privilegedDoorAvailable():
      return performFrameOSUpgradeThroughDoor(release)

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
  if privilegedDoorAvailable():
    # Not root: no transient unit to hide in. The child runs as this user
    # inside frameos.service's cgroup; the download and signature check are
    # its work, the install is the root worker's, and the worker restarts
    # this service (and with it, the child) once the release is in place.
    discard runSetupCommand("sh -c " & shellQuote("nohup " & redirected & " &"))
  elif commandExists("systemd-run"):
    discard runSetupCommand(privilegedCommand(
      "systemd-run --quiet --unit=frameos-upgrade --collect /bin/sh -lc " & shellQuote(redirected)
    ))
  else:
    discard runSetupCommand(privilegedCommand("sh -c " & shellQuote("nohup " & redirected & " &")))
  readUpgradeStatus()

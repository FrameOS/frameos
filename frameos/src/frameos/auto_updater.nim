## Automatic updates on a Linux frame with no control plane
## (docs/auto-updates.md, "Standalone Pi").
##
## A frame a backend or FrameOS Cloud manages is updated by its plane: the
## plane runs the update decision and nudges the frame (the admin API's
## `POST /api/upgrade {"version"}`, the cloud's `notify_update_available`).
## A frame with neither asks for itself, from this thread: ten minutes after
## boot and then every ten minutes it looks at the gates, and at most every six
## hours (an hour after a failed fetch) it reads the update manifest, runs the
## rule (update_decision.nim) and, when a version comes back, starts the same
## detached signed upgrade the admin page starts, pinned to that version.
##
## Gates, all cheap and read fresh every pass: frame.json `autoUpdate` not
## false, no backend (`serverHost` + `serverApiKey`), no cloud management,
## the local hour in [2, 5), nobody touched the frame in the last 15 minutes
## (event_loop's last-input time), no upgrade already in flight.
##
## Never a ref across threads: the config is read value by value through
## liveConfigValue, the decision is JSON this thread makes and drops.

import std/[json, monotimes, os, strutils, times]

import frameos/channels
import frameos/cloud/identity
import frameos/cloud/link_state
import frameos/event_loop
import frameos/server/state
import frameos/types
import frameos/update_decision
import frameos/upgrade
import frameos/utils/http_client

const
  UpdateManifestGitHubUrl* = "https://raw.githubusercontent.com/FrameOS/frameos/main/docs/update-manifest.json"
  UpdateManifestCloudUrl* = "https://cloud.frameos.net/api/updates/manifest"
  AutoUpdateFirstWaitSeconds* = 10 * 60
  AutoUpdatePassSeconds* = 10 * 60
  AutoUpdateCheckEverySeconds* = 6 * 3600
  AutoUpdateRetrySeconds* = 3600
  AutoUpdateWindowFromHour* = 2
  AutoUpdateWindowToHour* = 5
  AutoUpdateIdleMs* = 15'i64 * 60 * 1000
  UpdateManifestMaxBytes = 512 * 1024

type
  AutoUpdateFacts* = object
    ## What the gates look at, read fresh each pass.
    autoUpdate*: bool
    backendManaged*: bool
    cloudManaged*: bool
    localHour*: int
    msSinceInput*: int64   ## -1 = nobody since boot
    upgradeInFlight*: bool

  AutoUpdateHooks* = object
    ## Everything the check reaches outside itself, so a test runs it
    ## without a network, a clock or an upgrade.
    facts*: proc(): AutoUpdateFacts {.gcsafe.}
    fetchManifest*: proc(): JsonNode {.gcsafe.}   ## nil = none could be read
    currentVersion*: proc(): string {.gcsafe.}
    target*: proc(): string {.gcsafe.}            ## raises when unknown
    frameKey*: proc(): string {.gcsafe.}
    schedule*: proc(version: string) {.gcsafe.}
    log*: proc(payload: JsonNode) {.gcsafe.}
    nowIso*: proc(): string {.gcsafe.}

  AutoUpdatePass* = enum
    apSkipped     ## a gate said not now; nothing fetched
    apFailed      ## the manifest (or the target) could not be read
    apChecked     ## decided; nothing to install
    apScheduled   ## decided; the upgrade was started

proc autoUpdateGate*(facts: AutoUpdateFacts): string =
  ## "" = go; else why not now: disabled | backend | cloud | window |
  ## in_use | in_flight.
  if not facts.autoUpdate: return "disabled"
  if facts.backendManaged: return "backend"
  if facts.cloudManaged: return "cloud"
  if facts.localHour < AutoUpdateWindowFromHour or facts.localHour >= AutoUpdateWindowToHour:
    return "window"
  if facts.msSinceInput >= 0 and facts.msSinceInput < AutoUpdateIdleMs: return "in_use"
  if facts.upgradeInFlight: return "in_flight"
  ""

proc runAutoUpdatePass*(hooks: AutoUpdateHooks): AutoUpdatePass =
  ## One check: the gates, then the manifest and the decision, then the
  ## upgrade. Logs `autoupdate:check` with what it decided and why.
  let gate = autoUpdateGate(hooks.facts())
  if gate.len > 0:
    return apSkipped
  var target = ""
  try:
    target = hooks.target()
  except CatchableError as error:
    hooks.log(%*{"event": "autoupdate:check", "status": "error", "detail": "no release target: " & error.msg})
    return apFailed
  let manifest = hooks.fetchManifest()
  if manifest == nil or manifest.kind != JObject:
    hooks.log(%*{"event": "autoupdate:check", "status": "error", "detail": "no update manifest could be read"})
    return apFailed
  let current = hooks.currentVersion()
  let decision = decideUpdate(manifest, %*{
    "current": current, "platform": "linux", "target": target, "frameKey": hooks.frameKey(),
    "channel": "stable", "manual": false, "now": hooks.nowIso()})
  var line = %*{"event": "autoupdate:check", "current": current, "target": target,
                "reason": decision["reason"], "latest": decision["latest"],
                "version": decision["version"]}
  if decision["held"].kind == JObject:
    line["held"] = decision["held"]
  let version = decision["version"].getStr("")
  if version.len == 0:
    line["status"] = %"none"
    hooks.log(line)
    return apChecked
  line["status"] = %"installing"
  hooks.log(line)
  try:
    hooks.schedule(version)
  except CatchableError as error:
    hooks.log(%*{"event": "autoupdate:check", "status": "error", "version": version, "detail": error.msg})
    return apFailed
  apScheduled

proc nextCheckDelaySeconds*(pass: AutoUpdatePass): int =
  ## How long after a pass the next manifest read may come: a skip is looked at
  ## again on the next pass, a failure in an hour, a check in six hours.
  case pass
  of apSkipped: 0
  of apFailed: AutoUpdateRetrySeconds
  of apChecked, apScheduled: AutoUpdateCheckEverySeconds

# ---------------------------------------------------------------- the runtime

proc fetchUpdateManifest*(): JsonNode {.gcsafe.} =
  ## FRAMEOS_UPDATE_MANIFEST_URL, else GitHub's copy on main, else the cloud's
  ## mirror. nil when none answers with a JSON object.
  let configured = getEnv("FRAMEOS_UPDATE_MANIFEST_URL").strip()
  let urls = if configured.len > 0: @[configured] else: @[UpdateManifestGitHubUrl, UpdateManifestCloudUrl]
  for url in urls:
    try:
      var body = ""
      {.gcsafe.}:
        body = boundedGetContent(url, maxBytes = UpdateManifestMaxBytes, maxSeconds = 30)
      let parsed = parseJson(body)
      if parsed.kind == JObject:
        return parsed
    except CatchableError:
      discard
  nil

proc defaultFrameKey(): string {.gcsafe.} =
  try:
    {.gcsafe.}:
      if hasDeviceKeypair():
        return "device:" & ensureDeviceKeypair().publicKeyBase64
  except CatchableError:
    discard
  try:
    let host = readFile("/etc/hostname").strip()
    if host.len > 0:
      return "host:" & host
  except CatchableError:
    discard
  ""

proc defaultFacts(): AutoUpdateFacts {.gcsafe.} =
  {.gcsafe.}:
    let serverHost = liveConfigValue(serverHost)
    let serverApiKey = liveConfigValue(serverApiKey)
    result.autoUpdate = liveConfigValue(autoUpdate)
    result.backendManaged = serverHost.strip().len > 0 and serverApiKey.len > 0
    try:
      result.cloudManaged = loadCloudLinkState(){"mode"}.getStr("") == "managed"
    except CatchableError:
      result.cloudManaged = false
    result.localHour = now().hour
    result.msSinceInput = msSinceLastInput()
    result.upgradeInFlight = frameOSUpgradeInFlight()

proc defaultAutoUpdateHooks*(): AutoUpdateHooks =
  AutoUpdateHooks(
    facts: defaultFacts,
    fetchManifest: fetchUpdateManifest,
    currentVersion: proc(): string {.gcsafe.} =
      {.gcsafe.}: installedFrameOSVersion(),
    target: proc(): string {.gcsafe.} =
      {.gcsafe.}: detectUpgradeTarget(),
    frameKey: defaultFrameKey,
    schedule: proc(version: string) {.gcsafe.} =
      {.gcsafe.}:
        discard scheduleFrameOSUpgrade(version),
    log: proc(payload: JsonNode) {.gcsafe.} =
      log(payload),
    nowIso: proc(): string {.gcsafe.} =
      format(now().utc, "yyyy-MM-dd'T'HH:mm:ss'Z'"),
  )

var autoUpdaterThread: Thread[void]
var autoUpdaterStarted = false

proc autoUpdaterLoop() {.thread.} =
  let hooks = defaultAutoUpdateHooks()
  sleep(AutoUpdateFirstWaitSeconds * 1000)
  var nextCheckAt = getMonoTime()
  while true:
    if getMonoTime() >= nextCheckAt:
      var pass = apFailed
      try:
        pass = runAutoUpdatePass(hooks)
      except CatchableError as error:
        log(%*{"event": "autoupdate:check", "status": "error", "detail": error.msg})
      nextCheckAt = getMonoTime() + initDuration(seconds = nextCheckDelaySeconds(pass))
    sleep(AutoUpdatePassSeconds * 1000)

proc startAutoUpdater*() =
  ## Started once with the runtime (frameos.nim); never under -d:testing.
  if autoUpdaterStarted:
    return
  autoUpdaterStarted = true
  createThread(autoUpdaterThread, autoUpdaterLoop)

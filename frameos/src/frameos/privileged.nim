## The privileged door: how an unprivileged FrameOS runtime asks root for the
## handful of things that need root, without ever handing root a command.
##
## On Buildroot images `frameos.service` runs as the `frameos` user
## (docs/buildroot-privileges.md §3). Everything it still needs root for is an
## *enum* below — never a command string — and the arguments of each verb are
## validated here, on both sides, before anything runs. The transport is two
## directories on the FRAMEOS partition:
##
##   /srv/frameos/privileged/queue/<id>.json     written by the runtime (frameos)
##   /srv/frameos/privileged/results/<id>.json   written by the worker (root)
##
## `frameos-privileged.path` (PathExistsGlob=queue/*.json) starts
## `frameos-privileged.service`, a root oneshot that runs
## `frameos privileged-worker` (frameos/privileged_worker.nim): it drains the
## queue, executes each verb, writes the result and exits. Files are written
## to a temp name and renamed, so a half-written request is never picked up.
##
## What root executes is `/srv/frameos/current/frameos` — a binary the
## `frameos` user cannot replace: release directories are installed by root
## after the archive's minisign signature was verified (install-release), and
## the `current` symlink lives in a root-owned directory. A compromised runtime
## can therefore queue requests, but only these verbs, only with arguments
## that pass `validatePrivilegedArgs`, and only against code root installed.
##
## When the runtime already is root (Raspberry Pi OS installs, the armv6
## Buildroot image, a self-hosted backend's images) the door is simply not
## there (`privilegedDoorAvailable` is false) and callers keep doing the work
## in-process as before.

import std/[algorithm, json, os, strutils, sysrand, times]
import frameos/utils/system

when not defined(windows):
  from std/posix import geteuid

const
  PrivilegedDirEnv* = "FRAMEOS_PRIVILEGED_DIR"
  DefaultPrivilegedDir* = "/srv/frameos/privileged"
  PrivilegedQueueDirName* = "queue"
  PrivilegedResultsDirName* = "results"
  ## A request file bigger than this is not a request.
  MaxPrivilegedRequestBytes* = 64 * 1024
  ## Where the unprivileged upgrade stages a downloaded release archive for
  ## install-release. The worker refuses archives anywhere else.
  PrivilegedStagingDirName* = "staging"

type
  PrivilegedVerb* = enum
    pvReboot = "reboot"
    pvApplyDriverSetup = "apply-driver-setup"
    pvInstallRelease = "install-release"
    pvSetHostname = "set-hostname"
    pvSyncClock = "sync-clock"
    pvNmDeviceStatus = "nm-device-status"
    pvNmWifiList = "nm-wifi-list"
    pvNmConnections = "nm-connections"
    pvNmRadioOn = "nm-radio-on"
    pvNmHotspotStart = "nm-hotspot-start"
    pvNmHotspotStop = "nm-hotspot-stop"
    pvNmWifiConnect = "nm-wifi-connect"

  PrivilegedRequest* = object
    id*: string
    verb*: PrivilegedVerb
    args*: JsonNode

  PrivilegedResult* = object
    ok*: bool
    exitCode*: int
    output*: string
    error*: string
    data*: JsonNode
    timedOut*: bool

  ## Test seam: replaces the file transport so callers (portal, upgrade,
  ## reboot) can be exercised without a root worker.
  PrivilegedRequestHook* = proc(request: PrivilegedRequest): PrivilegedResult {.gcsafe.}

var privilegedRequestHook: PrivilegedRequestHook = nil
var privilegedForcedAvailable = false

proc setPrivilegedRequestHookForTest*(hook: PrivilegedRequestHook) =
  privilegedRequestHook = hook
  privilegedForcedAvailable = hook != nil

proc resetPrivilegedRequestHookForTest*() =
  privilegedRequestHook = nil
  privilegedForcedAvailable = false

proc privilegedDir*(): string =
  getEnv(PrivilegedDirEnv, DefaultPrivilegedDir).strip(leading = false, trailing = true, chars = {'/'})

proc privilegedQueueDir*(): string = privilegedDir() / PrivilegedQueueDirName
proc privilegedResultsDir*(): string = privilegedDir() / PrivilegedResultsDirName

proc privilegedStagingDir*(installDir = "/srv/frameos"): string =
  installDir / PrivilegedStagingDirName

proc runningAsRoot*(): bool =
  when defined(windows):
    false
  else:
    geteuid() == 0

proc privilegedDoorAvailable*(): bool {.gcsafe.} =
  ## True when this process should ask the root worker instead of doing
  ## privileged work itself: it is not root, and the queue directory the
  ## image (or a previous setup) created is there.
  {.gcsafe.}:
    if privilegedForcedAvailable:
      return true
  if runningAsRoot():
    return false
  dirExists(privilegedQueueDir())

# ---------------------------------------------------------------------------
# Argument validation — the same code runs on both sides of the door
# ---------------------------------------------------------------------------

proc parsePrivilegedVerb*(name: string): PrivilegedVerb =
  for verb in PrivilegedVerb:
    if $verb == name:
      return verb
  raise newException(ValueError, "Unknown privileged verb: " & name)

proc validInterfaceName*(value: string): bool =
  ## Linux interface names: 1..15 bytes, no '/', no whitespace, and not
  ## something nmcli could read as an option.
  if value.len == 0 or value.len > 15 or value[0] == '-':
    return false
  for c in value:
    if c notin {'a'..'z', 'A'..'Z', '0'..'9', '_', '.', ':', '-'}:
      return false
  true

proc validSsid*(value: string): bool =
  ## 1..32 bytes (the 802.11 limit), no control characters. Anything else
  ## — spaces, unicode, quotes — is a legitimate SSID and is passed as one
  ## argv entry, never through a shell.
  if value.len == 0 or value.len > 32:
    return false
  for c in value:
    if ord(c) < 0x20 or c == '\x7f':
      return false
  true

proc validPsk*(value: string): bool =
  ## WPA passphrase (8..63 printable ASCII) or a 64-hex-digit PSK. Empty is
  ## allowed and means an open network.
  if value.len == 0:
    return true
  if value.len == 64:
    for c in value:
      if c notin {'0'..'9', 'a'..'f', 'A'..'F'}:
        return false
    return true
  if value.len < 8 or value.len > 63:
    return false
  for c in value:
    if ord(c) < 0x20 or ord(c) > 0x7e:
      return false
  true

proc validReleaseVersion*(value: string): bool =
  ## Release artifacts use exactly three non-empty numeric CalVer fields.
  ## Keeping this strict also makes the requested version safe to use in an
  ## expected archive-root name on the root side.
  let parts = value.split('.')
  if parts.len != 3:
    return false
  for part in parts:
    if part.len == 0:
      return false
    for c in part:
      if c notin {'0'..'9'}:
        return false
  true

proc sanitizeHostname*(raw: string): string =
  ## The hostname rules portal.nim applies (lower-case letters, digits and
  ## single dashes, no leading/trailing dash, at most 63 characters), applied
  ## again on the root side so the worker never trusts what it was sent.
  var value = raw.strip().toLowerAscii()
  for prefix in ["https://", "http://"]:
    if value.startsWith(prefix):
      value = value[prefix.len .. ^1]
  if value.endsWith(".local"):
    value = value[0 ..< value.len - ".local".len]
  if value.contains(":"):
    value = value.split(":", 1)[0]
  if value.contains("/"):
    value = value.split("/", 1)[0]
  var lastWasDash = false
  for c in value:
    if c in {'a'..'z'} or c in {'0'..'9'}:
      result.add(c)
      lastWasDash = false
    elif c in {'-', '_', ' ', '.'}:
      if result.len > 0 and not lastWasDash:
        result.add('-')
        lastWasDash = true
  result = result.strip(chars = {'-'})
  if result.len > 63:
    result = result[0 ..< 63].strip(chars = {'-'})

proc argStr*(args: JsonNode, key: string): string =
  if args == nil or args.kind != JObject:
    return ""
  let node = args{key}
  if node == nil or node.kind != JString:
    return ""
  node.getStr("")

proc hasArg(args: JsonNode, key: string): bool =
  args != nil and args.kind == JObject and args.hasKey(key)

proc validatePrivilegedArgs*(verb: PrivilegedVerb, args: JsonNode): string =
  ## "" when the arguments are acceptable, otherwise the reason they are not.
  ## Unknown keys are refused: a verb takes exactly the fields listed here.
  let allowedKeys: seq[string] =
    case verb
    of pvReboot: @["delaySeconds"]
    of pvApplyDriverSetup: @["rebootIfRequired"]
    of pvInstallRelease: @["archive", "signature", "version"]
    of pvSetHostname: @["hostname"]
    of pvSyncClock, pvNmDeviceStatus, pvNmWifiList, pvNmRadioOn, pvNmHotspotStop: @[]
    of pvNmConnections: @["active"]
    of pvNmHotspotStart: @["device", "ssid", "psk"]
    of pvNmWifiConnect: @["ssid", "psk", "device"]
  if args != nil and args.kind != JObject:
    return "arguments must be an object"
  if args != nil:
    for key, _ in args.pairs:
      if key notin allowedKeys:
        return "unexpected argument: " & key
  case verb
  of pvReboot:
    if hasArg(args, "delaySeconds"):
      let node = args["delaySeconds"]
      if node.kind != JInt or node.getInt() < 0 or node.getInt() > 300:
        return "delaySeconds must be an integer between 0 and 300"
  of pvApplyDriverSetup:
    if hasArg(args, "rebootIfRequired") and args["rebootIfRequired"].kind != JBool:
      return "rebootIfRequired must be a boolean"
  of pvInstallRelease:
    let archive = argStr(args, "archive")
    if archive.len == 0 or not archive.startsWith("/") or ".." in archive.split('/'):
      return "archive must be an absolute path"
    if not archive.endsWith(".tar.gz"):
      return "archive must be a .tar.gz"
    let signature = argStr(args, "signature")
    if signature.len == 0 or signature.len > 8 * 1024:
      return "signature must be the .minisig text"
    let version = argStr(args, "version")
    if version.len > 64 or not validReleaseVersion(version):
      return "version must have exactly three numeric fields (YYYY.M.N)"
  of pvSetHostname:
    if sanitizeHostname(argStr(args, "hostname")).len == 0:
      return "hostname is empty after sanitizing"
  of pvNmConnections:
    if hasArg(args, "active") and args["active"].kind != JBool:
      return "active must be a boolean"
  of pvNmHotspotStart:
    if not validInterfaceName(argStr(args, "device")):
      return "device is not a valid interface name"
    if not validSsid(argStr(args, "ssid")):
      return "ssid must be 1..32 bytes without control characters"
    let psk = argStr(args, "psk")
    if psk.len == 0 or not validPsk(psk):
      return "psk must be a WPA passphrase (8..63 characters) or 64 hex digits"
  of pvNmWifiConnect:
    if not validSsid(argStr(args, "ssid")):
      return "ssid must be 1..32 bytes without control characters"
    if not validPsk(argStr(args, "psk")):
      return "psk must be empty, a WPA passphrase (8..63 characters) or 64 hex digits"
    if hasArg(args, "device") and not validInterfaceName(argStr(args, "device")):
      return "device is not a valid interface name"
  of pvSyncClock, pvNmDeviceStatus, pvNmWifiList, pvNmRadioOn, pvNmHotspotStop:
    discard
  ""

# ---------------------------------------------------------------------------
# Wire format
# ---------------------------------------------------------------------------

proc toJson*(request: PrivilegedRequest): JsonNode =
  %*{
    "id": request.id,
    "verb": $request.verb,
    "args": (if request.args == nil: newJObject() else: request.args),
    "created_at": epochTime(),
  }

proc parsePrivilegedRequest*(text: string): PrivilegedRequest =
  ## Raises ValueError for anything that is not a well-formed request with
  ## acceptable arguments. The worker treats a raise as "delete the file,
  ## write an error result if the id was readable".
  let node = parseJson(text)
  if node.kind != JObject:
    raise newException(ValueError, "request is not an object")
  let id = node{"id"}.getStr("")
  if id.len == 0 or id.len > 64:
    raise newException(ValueError, "request has no id")
  for c in id:
    if c notin {'a'..'z', 'A'..'Z', '0'..'9', '-', '_'}:
      raise newException(ValueError, "request id contains unexpected characters")
  let verbName = node{"verb"}.getStr("")
  result.id = id
  result.verb = parsePrivilegedVerb(verbName)
  if node.hasKey("args") and node["args"].kind != JObject:
    raise newException(ValueError, "request arguments must be an object")
  result.args = if node.hasKey("args") and node["args"].kind == JObject: node["args"] else: newJObject()
  let problem = validatePrivilegedArgs(result.verb, result.args)
  if problem.len > 0:
    raise newException(ValueError, $result.verb & ": " & problem)

proc toJson*(res: PrivilegedResult): JsonNode =
  result = %*{
    "ok": res.ok,
    "exit_code": res.exitCode,
    "output": res.output,
    "error": res.error,
  }
  if res.data != nil:
    result["data"] = res.data

proc parsePrivilegedResult*(text: string): PrivilegedResult =
  let node = parseJson(text)
  if node.kind != JObject:
    raise newException(ValueError, "result is not an object")
  result.ok = node{"ok"}.getBool(false)
  result.exitCode = node{"exit_code"}.getInt(if result.ok: 0 else: 1)
  result.output = node{"output"}.getStr("")
  result.error = node{"error"}.getStr("")
  result.data = node{"data"}

proc privilegedError*(message: string, exitCode = 1): PrivilegedResult =
  PrivilegedResult(ok: false, exitCode: exitCode, error: message)

proc privilegedOk*(output = "", data: JsonNode = nil): PrivilegedResult =
  PrivilegedResult(ok: true, exitCode: 0, output: output, data: data)

# ---------------------------------------------------------------------------
# Client side (runs as the frameos user)
# ---------------------------------------------------------------------------

proc newPrivilegedRequestId*(): string =
  var random = ""
  try:
    for b in urandom(8):
      random.add(toHex(int(b), 2).toLowerAscii)
  except CatchableError:
    random = toHex(int(epochTime() * 1_000_000), 12).toLowerAscii
  $(int64(epochTime() * 1000)) & "-" & random

proc requestPrivileged*(verb: PrivilegedVerb, args: JsonNode = nil,
                        timeoutMs = 60_000, pollMs = 100): PrivilegedResult {.gcsafe.} =
  ## Queue one request and wait for its result. Never raises: a door that
  ## is not answering, a malformed result or a timeout all come back as a
  ## failed PrivilegedResult the caller logs.
  let request = PrivilegedRequest(
    id: newPrivilegedRequestId(),
    verb: verb,
    args: if args == nil: newJObject() else: args,
  )
  let problem = validatePrivilegedArgs(verb, request.args)
  if problem.len > 0:
    return privilegedError($verb & ": " & problem)
  {.gcsafe.}:
    if privilegedRequestHook != nil:
      return privilegedRequestHook(request)

  let queueDir = privilegedQueueDir()
  let resultPath = privilegedResultsDir() / (request.id & ".json")
  try:
    writeFileAtomically(queueDir / (request.id & ".json"), $request.toJson() & "\n")
  except CatchableError as e:
    return privilegedError("cannot queue privileged request " & $verb & ": " & e.msg)

  let deadline = epochTime() + timeoutMs.float / 1000
  while true:
    if fileExists(resultPath):
      var text = ""
      try:
        text = readFile(resultPath)
      except CatchableError:
        text = ""
      if text.len > 0:
        try:
          result = parsePrivilegedResult(text)
        except CatchableError as e:
          result = privilegedError("unreadable privileged result for " & $verb & ": " & e.msg)
        # Best effort: on a Buildroot frame `results/` is root:frameos 2750,
        # so the runtime cannot delete anything there (nothing it writes may
        # be mistaken for the worker's answer). The worker prunes results
        # older than an hour whenever it next starts.
        try:
          removeFile(resultPath)
        except CatchableError:
          discard
        return
    if epochTime() >= deadline:
      # Withdraw the request if the worker never picked it up, so a dead
      # door does not accumulate stale work it would replay on recovery.
      try:
        removeFile(queueDir / (request.id & ".json"))
      except CatchableError:
        discard
      return PrivilegedResult(ok: false, exitCode: 124, timedOut: true,
        error: "privileged door did not answer " & $verb & " within " & $(timeoutMs div 1000) & "s")
    sleep(pollMs)

# ---------------------------------------------------------------------------
# Worker side helpers (the executor itself lives in privileged_worker.nim)
# ---------------------------------------------------------------------------

proc writePrivilegedResult*(resultsDir: string, id: string, res: PrivilegedResult) =
  createDir(resultsDir)
  writeFileAtomically(resultsDir / (id & ".json"), $res.toJson() & "\n",
    groupReadableOnly = true)

proc prunePrivilegedResults*(resultsDir: string, maxAgeSeconds = 3600.0): int =
  ## Drops results nobody came back for. A successful `install-release`
  ## restarts frameos.service, which kills the cgroup the waiting `frameos
  ## upgrade` child lives in — so exactly the results that matter most are
  ## the ones left behind. Returns how many were removed.
  if not dirExists(resultsDir):
    return
  let now = epochTime()
  for kind, path in walkDir(resultsDir):
    if kind != pcFile or not path.endsWith(".json"):
      continue
    try:
      if now - getLastModificationTime(path).toUnixFloat() > maxAgeSeconds:
        removeFile(path)
        inc result
    except CatchableError:
      discard

proc pendingPrivilegedRequestFiles*(queueDir: string, removeForeign = false): seq[string] =
  ## Regular request files in the queue, oldest first. Temp files (leading
  ## dot) are skipped, not deleted: the writer may still be renaming them
  ## into place.
  ##
  ## A `*.json` entry that is not a regular file — a symlink or a directory
  ## the runtime planted — is never a request, but it keeps matching the
  ## .path unit's `PathExistsGlob`, which would restart the root worker every
  ## few seconds until someone cleaned it up. With `removeForeign` (the
  ## worker's setting) such entries are deleted; the client-side callers only
  ## look.
  if not dirExists(queueDir):
    return
  var entries: seq[(times.Time, string)] = @[]
  for kind, path in walkDir(queueDir):
    let name = lastPathPart(path)
    if name.startsWith(".") or not name.endsWith(".json"):
      continue
    if kind != pcFile:
      if removeForeign:
        try:
          if kind == pcDir:
            removeDir(path)
          else:
            removeFile(path)
        except CatchableError:
          discard
      continue
    try:
      entries.add((getLastModificationTime(path), path))
    except CatchableError:
      continue
  entries.sort(proc(a, b: (times.Time, string)): int =
    let byTime = cmp(a[0], b[0])
    if byTime != 0: byTime else: cmp(a[1], b[1]))
  for entry in entries:
    result.add(entry[1])

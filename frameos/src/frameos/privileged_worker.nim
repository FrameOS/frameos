## Root side of the privileged door (frameos/privileged.nim).
##
## `frameos privileged-worker` is what `frameos-privileged.service` runs: as
## root, from /srv/frameos/current, triggered by `frameos-privileged.path`
## whenever the queue directory is not empty. It drains the queue, executes
## each verb, writes the result and exits once the queue has stayed empty for
## a moment.
##
## Every verb is a fixed piece of code with validated arguments. Nothing in a
## request is ever passed to a shell; nmcli and friends get argv entries.

import std/[json, os, strutils, times]

import frameos/buildroot_privileges
import frameos/config
import frameos/device_setup
import frameos/privileged
import frameos/setup
import frameos/types
import frameos/upgrade
import frameos/utils/process
import frameos/utils/system

const
  ## Keep in step with portal.nim — the runtime asks by role ("wifi",
  ## "hotspot"), the worker maps the role to the connection it manages.
  NmHotspotConnectionName* = "frameos-hotspot"
  NmWifiConnectionName* = "frameos-wifi"
  NmHotspotAddress* = "10.42.0.1/24"
  NmCommandTimeoutMs = 60 * 1000
  ClockSyncTimeoutMs = 120 * 1000
  ## After the queue empties the worker lingers this long for a follow-up
  ## request (the portal issues several nmcli calls in a row) before it
  ## exits and hands the watch back to the .path unit.
  DefaultLingerMs = 3000
  PollMs = 100

type
  ## Test seam for the process spawns: (program, argv) -> (rc, output).
  PrivilegedExecHook* = proc(program: string, args: seq[string], timeoutMs: int):
    tuple[rc: int, output: string] {.gcsafe.}

proc defaultExec(program: string, args: seq[string], timeoutMs: int): tuple[rc: int, output: string] {.gcsafe.} =
  let res = runProcessPiped(program, args, timeoutMs = timeoutMs, maxOutputBytes = 1024 * 1024)
  var output = res.output
  if res.errorOutput.len > 0:
    if output.len > 0 and not output.endsWith("\n"):
      output.add("\n")
    output.add(res.errorOutput)
  (rc: res.exitCode, output: output)

var execHook: PrivilegedExecHook = defaultExec
var workerExitRequested = false

proc setPrivilegedExecHookForTest*(hook: PrivilegedExecHook) =
  if hook == nil:
    execHook = defaultExec
  else:
    execHook = hook

proc workerLog(message: string) =
  echo "FrameOS privileged: " & message
  flushFile(stdout)

proc redactedExecArgs*(args: seq[string]): seq[string] =
  ## nmcli accepts secrets as the value after either spelling below. Keep
  ## process diagnostics useful without copying Wi-Fi credentials to the
  ## root worker's journal.
  result = args
  for i in 1 ..< result.len:
    if args[i - 1] in ["password", "802-11-wireless-security.psk"]:
      result[i] = "<redacted>"

proc exec(program: string, args: seq[string], timeoutMs = NmCommandTimeoutMs): tuple[rc: int, output: string] =
  workerLog("> " & program & " " & $redactedExecArgs(args))
  execHook(program, args, timeoutMs)

proc resultOf(res: tuple[rc: int, output: string]): PrivilegedResult =
  if res.rc == 0:
    privilegedOk(res.output)
  else:
    PrivilegedResult(ok: false, exitCode: res.rc, output: res.output,
      error: "command exited with " & $res.rc)

# ---------------------------------------------------------------------------
# Verbs
# ---------------------------------------------------------------------------

proc execReboot(args: JsonNode): PrivilegedResult =
  let delay = args{"delaySeconds"}.getInt(2)
  scheduleSystemReboot(delay)
  privilegedOk("reboot scheduled in " & $delay & "s")

proc execApplyDriverSetup(args: JsonNode): PrivilegedResult =
  let contextProblem = privilegedBuildrootContextProblem(loadConfig().mode)
  if contextProblem.len > 0:
    return privilegedError(contextProblem)
  let setupResult = setupFrameOSDrivers()
  let rebootIfRequired = args{"rebootIfRequired"}.getBool(false)
  var data = %*{"reboot_required": setupResult.rebootRequired, "rebooting": false}
  if setupResult.rebootRequired and rebootIfRequired:
    scheduleSystemReboot(2)
    data["rebooting"] = %true
  privilegedOk(data = data)

proc execInstallRelease(args: JsonNode): PrivilegedResult =
  let payload = installStagedReleaseArchive(
    archivePath = argStr(args, "archive"),
    minisig = argStr(args, "signature"),
    version = argStr(args, "version"),
  )
  let status = payload{"status"}.getStr("failed")
  if status == "failed":
    return PrivilegedResult(ok: false, exitCode: 1, error: payload{"message"}.getStr("install failed"), data: payload)
  privilegedOk(payload{"message"}.getStr(""), data = payload)

proc execSetHostname(args: JsonNode): PrivilegedResult =
  let hostname = sanitizeHostname(argStr(args, "hostname"))
  if hostname.len == 0:
    return privilegedError("hostname is empty after sanitizing")
  var problems: seq[string] = @[]
  try:
    writePrivilegedFile("/etc/hostname", hostname & "\n")
  except CatchableError as e:
    problems.add("/etc/hostname: " & e.msg)
  # /boot is root-only (umask=077); the first-boot script reads this back
  # on the next boot if it ever has to re-run.
  if dirExists("/boot"):
    try:
      writeFile("/boot/frameos-hostname", hostname & "\n")
    except CatchableError as e:
      problems.add("/boot/frameos-hostname: " & e.msg)
  let live = exec("hostname", @[hostname], timeoutMs = 10_000)
  if live.rc != 0:
    problems.add("hostname: " & live.output.strip())
  if problems.len > 0:
    return PrivilegedResult(ok: false, exitCode: 1, error: problems.join("; "))
  privilegedOk(hostname)

proc execSyncClock(): PrivilegedResult =
  ## Same ladder as portal.nim's syncClock, minus sudo.
  if fileExists("/run/systemd/system"):
    return resultOf(exec("systemctl", @["restart", "systemd-timesyncd.service"], ClockSyncTimeoutMs))
  if findExe("ntpd") != "":
    return resultOf(exec("ntpd", @["-gq"], ClockSyncTimeoutMs))
  if findExe("sntp") != "":
    return resultOf(exec("sntp", @["-sS", "pool.ntp.org"], ClockSyncTimeoutMs))
  privilegedError("no clock sync tool found")

proc nmcli(args: seq[string], timeoutMs = NmCommandTimeoutMs): tuple[rc: int, output: string] =
  exec("nmcli", args, timeoutMs)

proc execNmHotspotStart(args: JsonNode): PrivilegedResult =
  ## The add / modify / up sequence portal.nim runs for its setup hotspot.
  let device = argStr(args, "device")
  let ssid = argStr(args, "ssid")
  let psk = argStr(args, "psk")
  var steps: seq[string] = @[]
  let managed = nmcli(@["device", "set", device, "managed", "yes"])
  if managed.rc != 0:
    return PrivilegedResult(ok: false, exitCode: managed.rc, output: managed.output,
      error: "nmcli device set managed failed")
  steps.add("managed")
  discard nmcli(@["connection", "delete", NmHotspotConnectionName])
  let added = nmcli(@["connection", "add", "type", "wifi", "ifname", device,
                      "con-name", NmHotspotConnectionName, "autoconnect", "no", "ssid", ssid])
  if added.rc != 0:
    return PrivilegedResult(ok: false, exitCode: added.rc, output: added.output,
      error: "nmcli connection add failed")
  steps.add("add")
  let modified = nmcli(@["connection", "modify", NmHotspotConnectionName,
                         "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
                         "802-11-wireless-security.key-mgmt", "wpa-psk",
                         "802-11-wireless-security.psk", psk,
                         "ipv4.method", "shared", "ipv4.addresses", NmHotspotAddress,
                         "ipv6.method", "ignore"])
  if modified.rc != 0:
    discard nmcli(@["connection", "delete", NmHotspotConnectionName])
    return PrivilegedResult(ok: false, exitCode: modified.rc, output: modified.output,
      error: "nmcli connection modify failed")
  steps.add("modify")
  let up = nmcli(@["--wait", "15", "connection", "up", NmHotspotConnectionName])
  if up.rc != 0:
    discard nmcli(@["connection", "delete", NmHotspotConnectionName])
    return PrivilegedResult(ok: false, exitCode: up.rc, output: up.output,
      error: "nmcli connection up failed")
  steps.add("up")
  discard nmcli(@["connection", "modify", NmHotspotConnectionName, "802-11-wireless.ap-isolation", "1"])
  privilegedOk(steps.join(","), %*{"device": device})

proc execNmHotspotStop(): PrivilegedResult =
  discard nmcli(@["connection", "down", NmHotspotConnectionName])
  discard nmcli(@["connection", "delete", NmHotspotConnectionName])
  privilegedOk()

proc execNmWifiConnect(args: JsonNode): PrivilegedResult =
  ## `nmcli device wifi connect`, first pinned to the interface, then without
  ## (older NetworkManager builds reject ifname for some drivers) — exactly
  ## the two attempts portal.nim makes.
  let ssid = argStr(args, "ssid")
  let psk = argStr(args, "psk")
  let device = argStr(args, "device")
  discard nmcli(@["connection", "delete", NmWifiConnectionName])
  var base = @["--wait", "15", "device", "wifi", "connect", ssid]
  if psk.len > 0:
    base.add(["password", psk])
  var attempts: seq[seq[string]] = @[]
  if device.len > 0:
    attempts.add(base & @["ifname", device, "name", NmWifiConnectionName])
  attempts.add(base & @["name", NmWifiConnectionName])
  var last: tuple[rc: int, output: string]
  for attempt in attempts:
    last = nmcli(attempt)
    if last.rc == 0:
      return privilegedOk(last.output)
  PrivilegedResult(ok: false, exitCode: last.rc, output: last.output, error: "nmcli device wifi connect failed")

proc executePrivilegedRequest*(request: PrivilegedRequest): PrivilegedResult =
  ## Dispatch. The request was validated when it was parsed; this only maps
  ## verbs to work.
  try:
    case request.verb
    of pvReboot: execReboot(request.args)
    of pvApplyDriverSetup: execApplyDriverSetup(request.args)
    of pvInstallRelease: execInstallRelease(request.args)
    of pvSetHostname: execSetHostname(request.args)
    of pvSyncClock: execSyncClock()
    of pvNmDeviceStatus: resultOf(nmcli(@["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"]))
    of pvNmWifiList: resultOf(nmcli(@["--colors", "no", "-t", "-f", "ACTIVE,SSID", "device", "wifi", "list"]))
    of pvNmConnections:
      if request.args{"active"}.getBool(false):
        resultOf(nmcli(@["--colors", "no", "-t", "-f", "NAME", "connection", "show", "--active"]))
      else:
        resultOf(nmcli(@["--colors", "no", "-t", "-f", "NAME", "connection", "show"]))
    of pvNmRadioOn:
      discard exec("rfkill", @["unblock", "wifi"], timeoutMs = 10_000)
      resultOf(nmcli(@["radio", "wifi", "on"]))
    of pvNmHotspotStart: execNmHotspotStart(request.args)
    of pvNmHotspotStop: execNmHotspotStop()
    of pvNmWifiConnect: execNmWifiConnect(request.args)
  except CatchableError as e:
    PrivilegedResult(ok: false, exitCode: 1, error: $request.verb & ": " & e.msg)

# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

proc restoreRuntimeOwnership() =
  ## Every verb runs as root, and several of them write into the runtime's
  ## own directories: `install-release` and `apply-driver-setup` leave
  ## `state/upgrade-status.json`, log lines and setup output behind. Left
  ## root-owned, the next unprivileged write to that file fails with EACCES
  ## — which would break the *following* upgrade, not this one, and be a
  ## puzzle to debug. Restore the split ownership model after such a
  ## request: writable contents go back to the runtime, while shared
  ## directory roots and all code-loading paths stay owned by root.
  if not runningAsRoot():
    return
  try:
    let user = buildrootServiceUser(loadConfig(), installedServiceUser(), buildrootUsesNetworkManager())
    if user != "root":
      applyBuildrootOwnership(user)
  except CatchableError as e:
    # Never let this sink a request whose work already succeeded.
    workerLog("could not restore runtime ownership: " & e.msg)

proc handleRequestFile*(path: string, resultsDir: string): bool =
  ## Parse, execute, answer, remove. Returns false when the file was not a
  ## request at all (it is removed anyway so the queue cannot wedge).
  var text = ""
  var request: PrivilegedRequest
  var id = ""
  try:
    # The queue is the runtime's directory: between the listing and this
    # read it may have swapped the entry for a symlink, a FIFO or a hard
    # link. Open without following, insist on a regular single-link file,
    # and cap the size in the same call.
    text = readFileNoFollow(path, MaxPrivilegedRequestBytes)
    try:
      id = parseJson(text){"id"}.getStr("")
    except CatchableError:
      id = ""
    request = parsePrivilegedRequest(text)
  except CatchableError as e:
    workerLog("refusing " & lastPathPart(path) & ": " & e.msg)
    try:
      removeFile(path)
    except CatchableError:
      discard
    if id.len > 0 and id.len <= 64 and id.allCharsInSet({'a'..'z', 'A'..'Z', '0'..'9', '-', '_'}):
      try:
        writePrivilegedResult(resultsDir, id, privilegedError("refused: " & e.msg))
      except CatchableError:
        discard
    return false
  # Remove before executing: a verb that restarts frameos.service (or
  # reboots) must not leave its own request behind to be replayed.
  try:
    removeFile(path)
  except CatchableError:
    discard
  workerLog("executing " & $request.verb & " (" & request.id & ")")
  # install-release can switch /srv/frameos/current. Do not execute another
  # queued install with this now-old worker's compiled version and trust
  # assumptions; exit after answering so systemd starts the next request with
  # the newly current, root-owned binary.
  if request.verb == pvInstallRelease:
    workerExitRequested = true
  let started = epochTime()
  let res = executePrivilegedRequest(request)
  workerLog($request.verb & " " & (if res.ok: "ok" else: "failed: " & res.error) &
    " in " & formatFloat(epochTime() - started, ffDecimal, 2) & "s")
  # Only the verbs that write under /srv/frameos as root need the sweep; the
  # nm-* verbs the portal issues in bursts touch nothing there, and the sweep
  # walks the whole state tree (image caches included).
  if request.verb in {pvInstallRelease, pvApplyDriverSetup}:
    restoreRuntimeOwnership()
  try:
    writePrivilegedResult(resultsDir, request.id, res)
  except CatchableError as e:
    workerLog("could not write result for " & request.id & ": " & e.msg)
  true

proc drainPrivilegedQueue*(queueDir, resultsDir: string): int =
  ## Handles everything currently queued, oldest first. Returns how many
  ## files were processed.
  for path in pendingPrivilegedRequestFiles(queueDir, removeForeign = true):
    discard handleRequestFile(path, resultsDir)
    inc result
    if workerExitRequested:
      break

proc runPrivilegedWorker*(lingerMs = DefaultLingerMs): int =
  if not runningAsRoot():
    stderr.writeLine("frameos privileged-worker must run as root")
    return 1
  let queueDir = privilegedQueueDir()
  let resultsDir = privilegedResultsDir()
  workerExitRequested = false
  if not dirExists(queueDir):
    workerLog("queue directory missing: " & queueDir)
    return 0
  if fileExists("/srv/frameos/current/frame.json") and getCurrentDir() != "/srv/frameos/current":
    setCurrentDir("/srv/frameos/current")
  let pruned = prunePrivilegedResults(resultsDir)
  if pruned > 0:
    workerLog("pruned " & $pruned & " stale result(s)")
  var idleSince = epochTime()
  var handled = 0
  while true:
    let n = drainPrivilegedQueue(queueDir, resultsDir)
    if n > 0:
      handled += n
      idleSince = epochTime()
      if workerExitRequested:
        break
    elif (epochTime() - idleSince) * 1000 >= lingerMs.float:
      break
    else:
      sleep(PollMs)
  workerLog("done, handled " & $handled & " request(s)")
  0

import std/[json, os, sequtils, strutils, times]
when defined(posix):
  from std/posix import link, unlink, getuid, getpwuid
import ../privileged
import ../privileged_worker
import ../buildroot_privileges
import ../config
import ../utils/system

proc tempRoot(tag: string): string =
  result = getTempDir() / ("frameos-privileged-" & tag & "-" & $epochTime().int64)
  createDir(result)

template raisesIOOrOS(body: untyped): bool =
  ## True when `body` raises IOError or OSError (the no-follow readers do).
  var raised = false
  try:
    when typeof(body) is void:
      body
    else:
      discard body
  except IOError, OSError:
    raised = true
  raised

block test_verb_names_round_trip:
  for verb in PrivilegedVerb:
    doAssert parsePrivilegedVerb($verb) == verb
  doAssertRaises(ValueError):
    discard parsePrivilegedVerb("shell")
  doAssertRaises(ValueError):
    discard parsePrivilegedVerb("")

block test_argument_validation:
  doAssert validatePrivilegedArgs(pvReboot, nil) == ""
  doAssert validatePrivilegedArgs(pvReboot, %*{"delaySeconds": 10}) == ""
  doAssert validatePrivilegedArgs(pvReboot, %*{"delaySeconds": 9999}).len > 0
  doAssert validatePrivilegedArgs(pvReboot, %*{"cmd": "reboot"}).len > 0, "unknown keys are refused"
  doAssert validatePrivilegedArgs(pvApplyDriverSetup, %*{"rebootIfRequired": true}) == ""
  doAssert validatePrivilegedArgs(pvApplyDriverSetup, %*{"rebootIfRequired": "yes"}).len > 0
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/x/frameos.tar.gz", "signature": "untrusted comment: x\nRWQ...\n",
    "version": "2026.8.44"}) == ""
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/../releases/evil.tar.gz", "signature": "sig", "version": "2026.8.44"}).len > 0
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/x/frameos.zip", "signature": "sig", "version": "2026.8.44"}).len > 0
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/x/frameos.tar.gz", "signature": "sig", "version": "2026.8.44; rm -rf /"}).len > 0
  for malformed in ["2026", "2026.8", "2026..44", ".8.44", "2026.8.44.1"]:
    doAssert validatePrivilegedArgs(pvInstallRelease, %*{
      "archive": "/srv/frameos/staging/x/frameos.tar.gz", "signature": "sig", "version": malformed}).len > 0
  doAssert validatePrivilegedArgs(pvSetHostname, %*{"hostname": "My Frame"}) == ""
  doAssert validatePrivilegedArgs(pvSetHostname, %*{"hostname": "---"}).len > 0
  doAssert validatePrivilegedArgs(pvSetTimezone, %*{"zone": "Europe/Brussels"}) == ""
  doAssert validatePrivilegedArgs(pvSetTimezone, %*{"zone": "UTC"}) == ""
  doAssert validatePrivilegedArgs(pvSetTimezone, %*{"zone": "../../etc/shadow"}).len > 0, "no path shapes"
  doAssert validatePrivilegedArgs(pvSetTimezone, %*{"zone": ""}).len > 0
  doAssert validatePrivilegedArgs(pvSetTimezone, %*{"zone": "UTC", "extra": 1}).len > 0, "unknown keys are refused"
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home Wifi", "psk": "hunter2hunter2"}) == ""
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Open", "psk": ""}) == "", "open networks have no psk"
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home", "psk": "short"}).len > 0
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "x\x00y", "psk": "hunter2hunter2"}).len > 0
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home", "psk": "hunter2hunter2", "device": "wlan0"}) == ""
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home", "psk": "hunter2hunter2", "device": "--wait"}).len > 0
  doAssert validatePrivilegedArgs(pvNmHotspotStart, %*{"device": "wlan0", "ssid": "FrameOS-Setup", "psk": "frame1234"}) == ""
  doAssert validatePrivilegedArgs(pvNmHotspotStart, %*{"device": "wlan0", "ssid": "FrameOS-Setup", "psk": ""}).len > 0
  doAssert validatePrivilegedArgs(pvNmDeviceStatus, %*{"device": "wlan0"}).len > 0, "no-arg verbs refuse args"
  doAssert validatePrivilegedArgs(pvNmDeviceStatus, nil) == ""

block test_validators:
  doAssert validInterfaceName("wlan0")
  doAssert validInterfaceName("wlp2s0")
  doAssert not validInterfaceName("")
  doAssert not validInterfaceName("-x")
  doAssert not validInterfaceName("a b")
  doAssert not validInterfaceName("0123456789abcdef")
  doAssert validSsid("Café ☕")
  doAssert not validSsid("")
  doAssert not validSsid("x".repeat(33))
  doAssert validPsk("a".repeat(64).replace("a", "f"))
  doAssert not validPsk("g".repeat(64))
  doAssert not validPsk("x".repeat(7))
  doAssert validPsk("x".repeat(63))
  doAssert not validPsk("x".repeat(64) & "x")
  doAssert sanitizeHostname("https://My Frame.local") == "my-frame"
  doAssert sanitizeHostname("my frame:8787/x") == "my-frame"
  doAssert sanitizeHostname("  ") == ""
  doAssert sanitizeHostname("a".repeat(80)).len == 63
  doAssert validReleaseVersion("2026.8.44")
  doAssert not validReleaseVersion("2026..44")

block test_worker_log_arguments_hide_wifi_secrets:
  let password = "never-write-this-psk"
  let connect = redactedExecArgs(@["device", "wifi", "connect", "Home", "password", password])
  doAssert password notin $connect
  doAssert connect[^1] == "<redacted>"
  let modify = redactedExecArgs(@["connection", "modify", "frameos-hotspot",
    "802-11-wireless-security.psk", password, "ipv4.method", "shared"])
  doAssert password notin $modify
  doAssert modify[4] == "<redacted>"

block test_wire_format_round_trip:
  let request = PrivilegedRequest(id: "1-abc", verb: pvNmWifiConnect, args: %*{"ssid": "Home", "psk": "hunter2hunter2"})
  let parsed = parsePrivilegedRequest($request.toJson())
  doAssert parsed.id == "1-abc"
  doAssert parsed.verb == pvNmWifiConnect
  doAssert parsed.args["ssid"].getStr() == "Home"
  doAssertRaises(ValueError):
    discard parsePrivilegedRequest("""{"id": "x", "verb": "shell", "args": {"cmd": "id"}}""")
  doAssertRaises(ValueError):
    discard parsePrivilegedRequest("""{"id": "../x", "verb": "reboot", "args": {}}""")
  doAssertRaises(ValueError):
    discard parsePrivilegedRequest("""{"id": "x", "verb": "reboot", "args": {"cmd": "id"}}""")
  doAssertRaises(ValueError):
    discard parsePrivilegedRequest("""{"id": "x", "verb": "reboot", "args": "ignored"}""")
  doAssertRaises(ValueError):
    discard parsePrivilegedRequest("[1,2]")
  let res = PrivilegedResult(ok: true, exitCode: 0, output: "wlan0:wifi:connected\n", data: %*{"a": 1})
  let back = parsePrivilegedResult($res.toJson())
  doAssert back.ok and back.exitCode == 0 and back.output == "wlan0:wifi:connected\n" and back.data["a"].getInt() == 1
  let failed = parsePrivilegedResult($privilegedError("nope", 3).toJson())
  doAssert not failed.ok and failed.exitCode == 3 and failed.error == "nope"

block test_request_ids_are_filenames:
  let id = newPrivilegedRequestId()
  doAssert id.len > 10
  for c in id:
    doAssert c in {'0'..'9', 'a'..'f', '-'}

block test_door_available_only_without_root_and_with_queue:
  let root = tempRoot("door")
  putEnv(PrivilegedDirEnv, root)
  try:
    if runningAsRoot():
      doAssert not privilegedDoorAvailable(), "root never uses the door"
    else:
      doAssert not privilegedDoorAvailable(), "no queue directory, no door"
      createDir(root / PrivilegedQueueDirName)
      doAssert privilegedDoorAvailable()
  finally:
    delEnv(PrivilegedDirEnv)
    removeDir(root)

block test_request_times_out_and_withdraws_when_nobody_answers:
  let root = tempRoot("timeout")
  putEnv(PrivilegedDirEnv, root)
  try:
    createDir(root / PrivilegedQueueDirName)
    createDir(root / PrivilegedResultsDirName)
    let res = requestPrivileged(pvReboot, nil, timeoutMs = 250, pollMs = 20)
    doAssert not res.ok and res.timedOut, $res
    doAssert pendingPrivilegedRequestFiles(root / PrivilegedQueueDirName).len == 0, "withdrawn after the timeout"
  finally:
    delEnv(PrivilegedDirEnv)
    removeDir(root)

block test_request_hook_replaces_transport:
  var seen: seq[PrivilegedRequest] = @[]
  setPrivilegedRequestHookForTest(proc(request: PrivilegedRequest): PrivilegedResult {.gcsafe.} =
    {.gcsafe.}:
      seen.add(request)
    privilegedOk("done"))
  try:
    doAssert privilegedDoorAvailable(), "the hook forces the door on"
    let res = requestPrivileged(pvNmDeviceStatus)
    doAssert res.ok and res.output == "done"
    doAssert seen.len == 1 and seen[0].verb == pvNmDeviceStatus
    let refused = requestPrivileged(pvNmHotspotStart,
      %*{"device": "--bad", "ssid": "FrameOS", "psk": "frame1234"})
    doAssert not refused.ok and seen.len == 1, "invalid arguments never reach the transport"
  finally:
    resetPrivilegedRequestHookForTest()

block test_stale_results_are_pruned:
  # A successful install-release restarts frameos.service, killing the
  # cgroup the waiting `frameos upgrade` child lives in — so its result is
  # never collected. The worker prunes those on its next run.
  let root = tempRoot("prune")
  let resultsDir = root / PrivilegedResultsDirName
  createDir(resultsDir)
  try:
    writePrivilegedResult(resultsDir, "fresh", privilegedOk("recent"))
    writePrivilegedResult(resultsDir, "stale", privilegedOk("orphaned"))
    let freshPermissions = getFilePermissions(resultsDir / "fresh.json")
    doAssert fpGroupRead in freshPermissions and fpOthersRead notin freshPermissions
    let stalePath = resultsDir / "stale.json"
    let old = getTime() - initDuration(hours = 3)
    setLastModificationTime(stalePath, old)
    doAssert prunePrivilegedResults(resultsDir) == 1
    doAssert not fileExists(stalePath)
    doAssert fileExists(resultsDir / "fresh.json"), "a result someone may still be waiting for stays"
    doAssert prunePrivilegedResults(resultsDir) == 0
  finally:
    removeDir(root)

block test_atomic_write_replaces_a_symlink_without_touching_its_target:
  when defined(posix):
    let root = tempRoot("atomic-symlink")
    let victim = root / "victim"
    let destination = root / "status.json"
    try:
      writeFile(victim, "unchanged")
      createSymlink(victim, destination)
      writePrivateFile(destination, "safe")
      doAssert readFile(victim) == "unchanged"
      doAssert not symlinkExists(destination)
      doAssert readFile(destination) == "safe"
    finally:
      removeDir(root)

block test_sync_clock_waits_for_timesyncd_instead_of_restarting_it:
  # 2026-09-04, Cloud-5: restarting timesyncd on every retry of the boot
  # network check never let a sync finish. A running timesyncd is left alone;
  # the verb succeeds once the synchronized marker appears.
  let root = tempRoot("syncclock")
  let systemdDir = root / "systemd"
  let marker = root / "synchronized"
  createDir(systemdDir)
  var calls: seq[seq[string]] = @[]
  setPrivilegedExecHookForTest(proc(program: string, args: seq[string], timeoutMs: int): tuple[rc: int, output: string] {.gcsafe.} =
    {.gcsafe.}:
      calls.add(@[program] & args)
    (rc: 0, output: ""))
  setClockSyncProbeForTest(systemdDir, marker, 3000)
  try:
    # Already synchronized: no restart, immediate ok.
    writeFile(marker, "")
    var res = executePrivilegedRequest(PrivilegedRequest(id: "c1", verb: pvSyncClock, args: newJObject()))
    doAssert res.ok, res.error
    doAssert calls.anyIt(it == @["systemctl", "is-active", "--quiet", "systemd-timesyncd.service"])
    doAssert not calls.anyIt("restart" in it), "a running timesyncd must not be restarted: " & $calls
    doAssert not calls.anyIt("start" in it)

    # Not synchronized and the deadline passes: an error, still no restart.
    removeFile(marker)
    calls = @[]
    res = executePrivilegedRequest(PrivilegedRequest(id: "c2", verb: pvSyncClock, args: newJObject()))
    doAssert not res.ok
    doAssert res.error.contains("not synchronized")
    doAssert not calls.anyIt("restart" in it)

    # timesyncd inactive: it is started (not restarted), then waited for.
    calls = @[]
    setPrivilegedExecHookForTest(proc(program: string, args: seq[string], timeoutMs: int): tuple[rc: int, output: string] {.gcsafe.} =
      {.gcsafe.}:
        calls.add(@[program] & args)
      if args.len > 0 and args[0] == "is-active":
        return (rc: 3, output: "")
      (rc: 0, output: ""))
    writeFile(marker, "")
    res = executePrivilegedRequest(PrivilegedRequest(id: "c3", verb: pvSyncClock, args: newJObject()))
    doAssert res.ok, res.error
    doAssert calls.anyIt(it == @["systemctl", "start", "systemd-timesyncd.service"])
    doAssert not calls.anyIt("restart" in it)
  finally:
    setPrivilegedExecHookForTest(nil)
    setClockSyncProbeForTest("/run/systemd/system", "/run/systemd/timesync/synchronized", 45 * 1000)
    removeDir(root)

block test_worker_drains_queue_and_refuses_junk:
  let root = tempRoot("worker")
  let queueDir = root / PrivilegedQueueDirName
  let resultsDir = root / PrivilegedResultsDirName
  createDir(queueDir)
  createDir(resultsDir)
  var calls: seq[(string, seq[string])] = @[]
  setPrivilegedExecHookForTest(proc(program: string, args: seq[string], timeoutMs: int): tuple[rc: int, output: string] {.gcsafe.} =
    {.gcsafe.}:
      calls.add((program, args))
    if program == "nmcli" and args.len > 0 and args[^1] == "status":
      return (rc: 0, output: "wlan0:wifi:connected\nlo:loopback:unmanaged\n")
    (rc: 0, output: ""))
  try:
    writeFile(queueDir / "a.json", $PrivilegedRequest(id: "a", verb: pvNmDeviceStatus, args: newJObject()).toJson())
    sleep(20)
    writeFile(queueDir / "b.json", """{"id": "b", "verb": "shell", "args": {"cmd": "id"}}""")
    writeFile(queueDir / ".c.json.tmp", "half written")
    writeFile(queueDir / "d.json", $PrivilegedRequest(id: "d", verb: pvNmWifiConnect,
      args: %*{"ssid": "Home", "psk": "hunter2hunter2", "device": "wlan0"}).toJson())
    doAssert drainPrivilegedQueue(queueDir, resultsDir) == 3
    doAssert fileExists(queueDir / ".c.json.tmp"), "temp files are left to their writer"
    doAssert not fileExists(queueDir / "a.json") and not fileExists(queueDir / "b.json") and not fileExists(queueDir / "d.json")
    let a = parsePrivilegedResult(readFile(resultsDir / "a.json"))
    doAssert a.ok and "wlan0:wifi:connected" in a.output
    let b = parsePrivilegedResult(readFile(resultsDir / "b.json"))
    doAssert not b.ok and "shell" in b.error, b.error
    let d = parsePrivilegedResult(readFile(resultsDir / "d.json"))
    doAssert d.ok, d.error
    var sawConnect = false
    for call in calls:
      if call[0] == "nmcli" and "connect" in call[1]:
        sawConnect = true
        doAssert "Home" in call[1] and "hunter2hunter2" in call[1] and "wlan0" in call[1]
        doAssert "frameos-wifi" in call[1]
    doAssert sawConnect
    var sawShell = false
    for call in calls:
      if call[0] in ["sh", "/bin/sh", "bash"]:
        sawShell = true
    doAssert not sawShell, "the worker never spawns a shell"
  finally:
    setPrivilegedExecHookForTest(nil)
    removeDir(root)

block test_ownership_script_covers_what_the_root_worker_writes:
  # The worker runs every verb as root, so `install-release` and
  # `apply-driver-setup` leave root-owned files in state/ and logs/ — including
  # upgrade-status.json, which the unprivileged runtime rewrites on the NEXT
  # upgrade. handleRequestFile calls restoreRuntimeOwnership after each
  # request; this pins that the script it uses actually covers those paths.
  let ownership = buildrootOwnershipScript("frameos", "/srv/frameos")
  for path in ["state", "logs", "runtime", "staging"]:
    doAssert ("/srv/frameos'/" & path) in ownership or ("'/srv/frameos'/" & path) in ownership,
      "ownership script does not cover " & path & ": " & ownership
  doAssert "for p in logs tmp runtime staging state" in ownership
  doAssert "chmod 1770" in ownership
  doAssert "chmod 2750" in ownership
  # The script hands things to root only. Handing files to the runtime user
  # is chownRuntimeTrees (Nim, descriptor-pinned, refuses hard links): a
  # `chown frameos:frameos` in busybox sh would follow a runtime-planted hard
  # link to root's binary, and Buildroot's busybox find has no `-links`.
  doAssert "frameos:frameos" notin ownership, ownership
  doAssert "chown -h 'frameos" notin ownership, ownership
  doAssert "rm -f \"$r/$sub\"" in ownership, "a runtime-planted drivers/scenes/vendor entry is removed, not adopted"
  # The door worker unpacks releases under UMask=0027, and the runtime must
  # still dlopen drivers/*.so and read vendor/: modes are set, not inherited.
  # (2026.9.5 through the door: drivers/ 0750, *.so 0640, no driver loaded.)
  doAssert "chown -R root:root \"$r/$sub\"; chmod -R u=rwX,go=rX \"$r/$sub\"" in ownership,
    "code roots must be made world-readable after the root chown"
  doAssert "chmod 0644 \"$r/frameos.service\"" in ownership
  doAssert "chmod -R u=rwX,go=rX '/srv/frameos'/vendor" in ownership

block test_runtime_chown_is_pinned_and_refuses_hard_links:
  # chownRuntimeTrees is what makes root-written frame.json / upgrade-status
  # writable by the runtime again. Run as the current user against a temp
  # layout: a chown to oneself succeeds, so the report shows exactly which
  # entries would be handed over — and which are refused.
  when defined(posix):
    let root = tempRoot("chown")
    try:
      let me = $getpwuid(getuid()).pw_name
      let release = root / "releases" / "release_1"
      createDir(release / "drivers")
      createDir(root / "state" / "NetworkManager" / "system-connections")
      createDir(root / "logs")
      createDir(root / "tmp")
      writeFile(release / "frameos", "#!/bin/sh\n")
      writeFile(release / "frameos.service", "[Unit]\n")
      writeFile(release / "frame.json", "{}\n")
      writeFile(release / "scenes.json.gz", "gz")
      # The attack: a hard link to root's binary under a runtime-looking name.
      doAssert link(cstring(release / "frameos"), cstring(release / "evil.json")) == 0
      createSymlink("/etc/hosts", release / "hosts.json")
      writeFile(root / "state" / "upgrade-status.json", "{}\n")
      writeFile(root / "state" / "NetworkManager" / "system-connections" / "wifi.nmconnection", "psk=secret\n")
      writeFile(root / "logs" / "setup.log", "x\n")
      doAssert link(cstring(root / "logs" / "setup.log"), cstring(root / "tmp" / "sneaky")) == 0
      let report = chownRuntimeTrees(me, root)
      doAssert release / "frame.json" in report.changed
      doAssert release / "scenes.json.gz" in report.changed
      doAssert root / "state" / "upgrade-status.json" in report.changed
      doAssert release / "evil.json" in report.skipped, $report
      doAssert root / "tmp" / "sneaky" in report.skipped, $report
      doAssert root / "logs" / "setup.log" in report.skipped, "both names of a shared inode are refused"
      doAssert release / "frameos" notin report.changed and release / "frameos.service" notin report.changed
      doAssert release / "hosts.json" notin report.skipped, "a symlink is lchown'ed, never followed"
      var sawKeyfile = false
      for path in report.changed & report.skipped & report.failed:
        if "NetworkManager" in path:
          sawKeyfile = true
      doAssert not sawKeyfile, "NetworkManager keyfiles are pruned: " & $report
      doAssert report.failed.len == 0, $report
      doAssert card(getFilePermissions(release / "frame.json") * {fpGroupRead, fpOthersRead}) == 0, "frame.json is 0600"
      doAssert raisesIOOrOS(chownRuntimeTrees("no-such-user-frameos-test", root)), "an unknown user raises"
    finally:
      removeDir(root)

block test_runtime_planted_code_roots_are_removed:
  when defined(posix):
    let root = tempRoot("coderoots")
    try:
      let release = root / "releases" / "release_1"
      createDir(release)
      createSymlink(root, release / "scenes")
      writeFile(release / "vendor", "not a directory")
      # Owned by the current (non-root) user: the runtime made it.
      createDir(release / "drivers")
      writeFile(release / "drivers" / "libevil.so", "\x7fELF")
      let removed = pruneRuntimePlantedCodeRoots(root)
      doAssert release / "scenes" in removed and release / "vendor" in removed, $removed
      doAssert not symlinkExists(release / "scenes") and not fileExists(release / "vendor")
      doAssert dirExists(root), "removing the symlink never touches its target"
      doAssert (release / "drivers" in removed) == (getuid() != 0), $removed
      if getuid() != 0:
        doAssert not dirExists(release / "drivers")
    finally:
      removeDir(root)

block test_no_follow_read_refuses_links:
  when defined(posix):
    let root = tempRoot("nofollow")
    try:
      writeFile(root / "plain", "hello")
      createSymlink(root / "plain", root / "link")
      doAssert link(cstring(root / "plain"), cstring(root / "hard")) == 0
      createDir(root / "dir")
      # `plain` has two links while `hard` exists, so both names are refused.
      for name in ["plain", "hard", "link", "dir", "missing"]:
        doAssert raisesIOOrOS(readFileNoFollow(root / name)), name & " should have been refused"
      doAssert unlink(cstring(root / "hard")) == 0
      doAssert readFileNoFollow(root / "plain") == "hello"
      doAssert readFileNoFollow(root / "plain", 5) == "hello"
      doAssert raisesIOOrOS(readFileNoFollow(root / "plain", 4)), "the size cap is enforced"
      copyFileNoFollow(root / "plain", root / "copy")
      doAssert readFile(root / "copy") == "hello"
      doAssert raisesIOOrOS(copyFileNoFollow(root / "link", root / "copy2")), "the copy never follows a symlink"
      doAssert not fileExists(root / "copy2") or readFile(root / "copy2") == ""
    finally:
      removeDir(root)

block test_worker_removes_planted_queue_entries:
  # A symlink or directory named *.json keeps PathExistsGlob true forever and
  # would restart the root worker every few seconds; the worker deletes them.
  let root = tempRoot("planted")
  let queueDir = root / PrivilegedQueueDirName
  let resultsDir = root / PrivilegedResultsDirName
  createDir(queueDir)
  createDir(resultsDir)
  setPrivilegedExecHookForTest(proc(program: string, args: seq[string], timeoutMs: int): tuple[rc: int, output: string] {.gcsafe.} =
    (rc: 0, output: ""))
  try:
    createSymlink("/etc/hostname", queueDir / "sym.json")
    createDir(queueDir / "dir.json")
    writeFile(queueDir / "dir.json" / "inner", "x")
    writeFile(queueDir / ".keep.json", "temp")
    doAssert pendingPrivilegedRequestFiles(queueDir).len == 0
    doAssert symlinkExists(queueDir / "sym.json") and dirExists(queueDir / "dir.json"), "the listing alone deletes nothing"
    doAssert drainPrivilegedQueue(queueDir, resultsDir) == 0
    doAssert not symlinkExists(queueDir / "sym.json") and not dirExists(queueDir / "dir.json")
    doAssert fileExists(queueDir / ".keep.json"), "temp files are still the writer's"
    # And a request that turned into a symlink between listing and reading is
    # refused rather than read through.
    createSymlink("/etc/hostname", queueDir / "late.json")
    doAssert not handleRequestFile(queueDir / "late.json", resultsDir)
    doAssert not symlinkExists(queueDir / "late.json")
  finally:
    setPrivilegedExecHookForTest(nil)
    removeDir(root)

block test_hotspot_start_sequence_cleans_up_on_failure:
  var calls: seq[seq[string]] = @[]
  setPrivilegedExecHookForTest(proc(program: string, args: seq[string], timeoutMs: int): tuple[rc: int, output: string] {.gcsafe.} =
    {.gcsafe.}:
      calls.add(args)
    if args.len >= 2 and args[0] == "connection" and args[1] == "modify" and "802-11-wireless.mode" in args:
      return (rc: 1, output: "Error: property is invalid")
    (rc: 0, output: ""))
  try:
    let res = executePrivilegedRequest(PrivilegedRequest(id: "h", verb: pvNmHotspotStart,
      args: %*{"device": "wlan0", "ssid": "FrameOS-Setup", "psk": "frame1234"}))
    doAssert not res.ok and "modify" in res.error
    doAssert calls[^1][0 .. 1] == @["connection", "delete"], "a half-made hotspot connection is removed"
  finally:
    setPrivilegedExecHookForTest(nil)

block test_nm_names_match_portal:
  # portal.nim keeps its own copies of these names for the sudo path; the
  # door path answers by role, so the worker's names must be the same ones.
  doAssert NmHotspotConnectionName == "frameos-hotspot"
  doAssert NmWifiConnectionName == "frameos-wifi"

block test_buildroot_unit_rendering:
  let unprivileged = renderBuildrootFrameosService("frameos", usesNetworkManager = true)
  doAssert "User=frameos\n" in unprivileged
  doAssert "Group=frameos\n" in unprivileged
  doAssert "NoNewPrivileges=yes\n" in unprivileged
  doAssert "ProtectSystem=strict\n" in unprivileged
  doAssert "Wants=NetworkManager.service\nAfter=network.target NetworkManager.service\n" in unprivileged
  doAssert "ExecStartPre=+/bin/sh -c 'for n in /dev/gpiochip*" in unprivileged
  doAssert "chgrp frameos" in unprivileged
  doAssert "__FRAMEOS_UNPRIVILEGED_SERVICE__" notin unprivileged
  doAssert "%I" notin unprivileged
  doAssert "Environment=FRAMEOS_HOME=/srv/frameos/current\n" in unprivileged
  doAssert "SupplementaryGroups=video input\n" in unprivileged
  doAssert "SupplementaryGroups=video input tty" notin unprivileged
  doAssert "Environment=LD_LIBRARY_PATH=/srv/frameos/current/drivers:/usr/lib:/usr/local/lib\n" in unprivileged
  doAssert unprivileged.endsWith("[Install]\nWantedBy=multi-user.target\n")
  let root = renderBuildrootFrameosService("root", usesNetworkManager = false)
  doAssert "User=root\n" in root
  doAssert "NoNewPrivileges" notin root
  doAssert "ExecStartPre" notin root
  doAssert "NetworkManager" notin root
  doAssert "After=network.target\n" in root
  doAssert "__FRAMEOS_UNPRIVILEGED_SERVICE__" notin root
  doAssert "ExecStopPost=-/bin/sh -lc 'mkdir -p /srv/frameos/runtime;" in root
  doAssert "ExecStopPost=-+/bin/sh" notin root

block test_buildroot_service_user_rule:
  var config = parseFrameConfig("""{"mode": "buildroot", "serverHost": "", "agent": {"agentEnabled": false}}""")
  doAssert buildrootServiceUser(config, "", usesNetworkManager = true) == "frameos"
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = true) == "frameos",
    "a generic frame upgraded from a root-only release migrates"
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = false) == "root",
    "the wpa_supplicant image stays root"
  # An enabled agent with no shared secret is the old generic-image default,
  # not a backend: such a frame still migrates.
  config = parseFrameConfig("""{"mode": "buildroot", "serverHost": "", "agent": {"agentEnabled": true, "agentSharedSecret": ""}}""")
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = true) == "frameos",
    "agentEnabled without a secret is not backend-managed"
  config = parseFrameConfig("""{"mode": "buildroot", "serverHost": "", "agent": {"agentEnabled": true, "agentSharedSecret": "s3cret"}}""")
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = true) == "root",
    "an agent a backend can use keeps the installed user"
  config = parseFrameConfig("""{"mode": "buildroot", "serverHost": "backend.local", "agent": {"agentEnabled": true}}""")
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = true) == "root"
  doAssert buildrootServiceUser(config, "", usesNetworkManager = true) == "root"
  doAssert buildrootServiceUser(config, "pi", usesNetworkManager = true) == "pi"
  putEnv("FRAMEOS_BUILDROOT_SERVICE_USER", "root")
  try:
    config = parseFrameConfig("""{"mode": "buildroot"}""")
    doAssert buildrootServiceUser(config, "frameos", usesNetworkManager = true) == "root"
  finally:
    delEnv("FRAMEOS_BUILDROOT_SERVICE_USER")

block test_buildroot_user_lines_and_scripts:
  doAssert buildrootPasswdLine() == "frameos:x:990:990:FrameOS runtime:/srv/frameos:/bin/false"
  doAssert buildrootGroupLine() == "frameos:x:990:"
  doAssert buildrootShadowLine() == "frameos:*:::::::"
  let userScript = buildrootUserSetupScript(etcDir = "/tmp/etc")
  doAssert "'/tmp/etc/passwd'" in userScript and "'/tmp/etc/group'" in userScript and "'/tmp/etc/shadow'" in userScript
  doAssert "is taken by another user" in userScript
  let ownership = buildrootOwnershipScript("frameos", "/srv/frameos")
  doAssert "chmod 1775" in ownership, "release dirs are sticky so the runtime cannot replace root's binary"
  doAssert "chown root:root \"$r/frameos\"" in ownership
  doAssert "for sub in drivers scenes vendor" in ownership
  doAssert "'/srv/frameos'/privileged/queue" in ownership and "chmod 1770" in ownership
  doAssert "'/srv/frameos'/privileged/results" in ownership and "chmod 2750" in ownership
  doAssert "chown -R root:root '/srv/frameos'/state/$p && chmod 0700 '/srv/frameos'/state/$p" in ownership,
    "NetworkManager keyfiles stay root's"
  doAssert "PathExistsGlob=/srv/frameos/privileged/queue/*.json" in BuildrootPrivilegedPathUnit
  doAssert "/srv/frameos/current/scenes" notin BuildrootPrivilegedServiceUnit

block test_user_setup_script_runs:
  # The generated sh is executed for real against a scratch /etc; it must
  # create the lines once and refuse a taken uid.
  when defined(posix):
    let root = tempRoot("etc")
    try:
      writeFile(root / "passwd", "root:x:0:0:root:/root:/bin/sh\n")
      writeFile(root / "group", "root:x:0:\n")
      writeFile(root / "shadow", "root::::::::\n")
      let script = buildrootUserSetupScript(etcDir = root)
      doAssert execShellCmd("sh -c " & quoteShell(script)) == 0
      doAssert readFile(root / "passwd").endsWith(buildrootPasswdLine() & "\n")
      doAssert readFile(root / "group").endsWith(buildrootGroupLine() & "\n")
      doAssert readFile(root / "shadow").endsWith(buildrootShadowLine() & "\n")
      doAssert execShellCmd("sh -c " & quoteShell(script)) == 0, "idempotent"
      doAssert readFile(root / "passwd").count("\nframeos:x:") == 1
      writeFile(root / "passwd", "root:x:0:0:root:/root:/bin/sh\nother:x:990:990::/:/bin/false\n")
      doAssert execShellCmd("sh -c " & quoteShell(script)) != 0, "a taken uid is refused, not duplicated"
      doAssert "frameos:" notin readFile(root / "passwd")
      writeFile(root / "passwd", "root:x:0:0:root:/root:/bin/sh\nframeos:x:991:991::/:/bin/false\n")
      writeFile(root / "group", "root:x:0:\nframeos:x:991:\n")
      doAssert execShellCmd("sh -c " & quoteShell(script)) != 0,
        "the right name with the wrong ids must not pass validation"
    finally:
      removeDir(root)

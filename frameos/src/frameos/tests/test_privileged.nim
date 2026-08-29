import std/[json, os, strutils, times]
import ../privileged
import ../privileged_worker
import ../buildroot_privileges
import ../config
import ../types

proc tempRoot(tag: string): string =
  result = getTempDir() / ("frameos-privileged-" & tag & "-" & $epochTime().int64)
  createDir(result)

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
  doAssert validatePrivilegedArgs(pvApplySetup, %*{"rebootIfRequired": true}) == ""
  doAssert validatePrivilegedArgs(pvApplySetup, %*{"rebootIfRequired": "yes"}).len > 0
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/x/frameos.tar.gz", "signature": "untrusted comment: x\nRWQ...\n",
    "version": "2026.8.44"}) == ""
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/../releases/evil.tar.gz", "signature": "sig", "version": "2026.8.44"}).len > 0
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/x/frameos.zip", "signature": "sig", "version": "2026.8.44"}).len > 0
  doAssert validatePrivilegedArgs(pvInstallRelease, %*{
    "archive": "/srv/frameos/staging/x/frameos.tar.gz", "signature": "sig", "version": "2026.8.44; rm -rf /"}).len > 0
  doAssert validatePrivilegedArgs(pvSetHostname, %*{"hostname": "My Frame"}) == ""
  doAssert validatePrivilegedArgs(pvSetHostname, %*{"hostname": "---"}).len > 0
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home Wifi", "psk": "hunter2hunter2"}) == ""
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Open", "psk": ""}) == "", "open networks have no psk"
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home", "psk": "short"}).len > 0
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "x\x00y", "psk": "hunter2hunter2"}).len > 0
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home", "psk": "hunter2hunter2", "device": "wlan0"}) == ""
  doAssert validatePrivilegedArgs(pvNmWifiConnect, %*{"ssid": "Home", "psk": "hunter2hunter2", "device": "--wait"}).len > 0
  doAssert validatePrivilegedArgs(pvNmHotspotStart, %*{"device": "wlan0", "ssid": "FrameOS-Setup", "psk": "frame1234"}) == ""
  doAssert validatePrivilegedArgs(pvNmHotspotStart, %*{"device": "wlan0", "ssid": "FrameOS-Setup", "psk": ""}).len > 0
  doAssert validatePrivilegedArgs(pvNmForget, %*{"connection": "wifi"}) == ""
  doAssert validatePrivilegedArgs(pvNmForget, %*{"connection": "eth0"}).len > 0
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
    let refused = requestPrivileged(pvNmForget, %*{"connection": "eth0"})
    doAssert not refused.ok and seen.len == 1, "invalid arguments never reach the transport"
  finally:
    resetPrivilegedRequestHookForTest()

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
  # `apply-setup` leave root-owned files in state/ and logs/ — including
  # upgrade-status.json, which the unprivileged runtime rewrites on the NEXT
  # upgrade. handleRequestFile calls restoreRuntimeOwnership after each
  # request; this pins that the script it uses actually covers those paths.
  let ownership = buildrootOwnershipScript("frameos", "/srv/frameos")
  for path in ["state", "logs", "runtime", "staging"]:
    doAssert ("/srv/frameos'/" & path) in ownership or ("'/srv/frameos'/" & path) in ownership,
      "ownership script does not cover " & path & ": " & ownership
  doAssert "chown -R 'frameos:frameos' '/srv/frameos'/logs" in ownership or
    "chown -R 'frameos:frameos' '/srv/frameos'/$p" in ownership or
    "for p in logs tmp runtime staging privileged/results" in ownership,
    "logs are not chowned recursively"

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
  doAssert unprivileged.endsWith("[Install]\nWantedBy=multi-user.target\n")
  let root = renderBuildrootFrameosService("root", usesNetworkManager = false)
  doAssert "User=root\n" in root
  doAssert "NoNewPrivileges" notin root
  doAssert "ExecStartPre" notin root
  doAssert "NetworkManager" notin root
  doAssert "After=network.target\n" in root
  doAssert "__FRAMEOS_UNPRIVILEGED_SERVICE__" notin root
  doAssert "ExecStopPost=-+/bin/sh -lc 'mkdir -p /srv/frameos/runtime;" in root

block test_buildroot_service_user_rule:
  var config = parseFrameConfig("""{"mode": "buildroot", "serverHost": "", "agent": {"agentEnabled": false}}""")
  doAssert buildrootServiceUser(config, "", usesNetworkManager = true) == "frameos"
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = true) == "frameos",
    "a generic frame upgraded from a root-only release migrates"
  doAssert buildrootServiceUser(config, "root", usesNetworkManager = false) == "root",
    "the wpa_supplicant image stays root"
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
  doAssert "'/srv/frameos'/privileged/queue" in ownership and "chmod 1770" in ownership
  doAssert "-path '/srv/frameos'/state/NetworkManager" in ownership, "NetworkManager keyfiles stay root's"

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
    finally:
      removeDir(root)

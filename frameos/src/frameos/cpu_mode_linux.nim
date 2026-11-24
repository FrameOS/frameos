## The processor speed of a Linux frame, the runtime's half: frame.json's
## `deviceConfig.cpuMode` (the contract's `cpu_mode`; a cloud push lands
## there, server/api.nim) applied as the kernel's governor
## (cpu_governor.nim has the mapping) at start and on every reload, and
## reported in the hardware report.
##
## Never fatal and never in the way: what can be decided from sysfs is
## decided on the caller's thread (a few small reads), and a write that may
## wait on the privileged door runs on a short-lived thread of its own, so a
## reload or the boot never waits for root. The ladder:
##
##   1. write the policy files (the runtime is root: Raspberry Pi OS images
##      a backend set up, the armv6 Buildroot image, a backend's images);
##   2. the privileged door (`set-cpu-governor`, privileged.nim): a
##      Buildroot runtime running as `frameos`;
##   3. `sudo -n tee` (Raspberry Pi OS's `pi` user, as the rest of setup).
##
## No cpufreq (a container, a desktop without it) is nothing to do, said
## nowhere. A governor the kernel does not offer (intel_pstate has only
## performance and powersave) is left as it is and logged once.

import std/[json, locks, os, strutils]
import frameos/channels
import frameos/cpu_governor
import frameos/privileged
import frameos/utils/process

export normalizeCpuMode

type
  CpuGovernorWriter* = proc(policyDir, governor: string): string {.gcsafe.}
  CpuGovernorSudo* = proc(policyDir, governor: string): string {.gcsafe.}

proc sudoWriteCpuGovernor(policyDir, governor: string): string {.gcsafe.} =
  ## `sudo -n tee <policy>/scaling_governor`, the governor on stdin: no shell,
  ## and only an allow-listed name into a policy's own file.
  if not isCpuGovernor(governor) or not isCpuPolicyName(policyDir.lastPathPart):
    return "refused"
  let res = runProcessPiped("sudo", @["-n", "tee", governorFile(policyDir)], input = governor,
    timeoutMs = 10_000, maxOutputBytes = 1024)
  if res.exitCode == 0: "" else: (res.errorOutput.strip() & " (exit " & $res.exitCode & ")").strip()

var
  cpuModeLock: Lock
  # What the worker thread is to apply next ("" for nothing), whether a
  # worker runs, and the state below: all under cpuModeLock.
  cpuModeWanted: string
  cpuModeWorkerRunning: bool
  cpuModeThread: Thread[void]
  cpuModeThreadStarted: bool
  # The governor last said to be unavailable, so it is said once.
  cpuModeUnavailableSaid: string
  # The cpufreq root the runtime applies to. "" under -d:testing, so no test
  # binary changes the governor of the machine it runs on.
  cpuModeRoot: string = (when defined(testing): "" else: CpufreqRoot)
  cpuModeWriter: CpuGovernorWriter = CpuGovernorWriter(writeCpuGovernor)
  cpuModeSudo: CpuGovernorSudo = CpuGovernorSudo(sudoWriteCpuGovernor)
initLock(cpuModeLock)

proc setCpuModeHooksForTest*(root: string, writer: CpuGovernorWriter = nil,
                             sudo: CpuGovernorSudo = nil) =
  withLock cpuModeLock:
    cpuModeRoot = root
    cpuModeUnavailableSaid = ""
  cpuModeWriter = CpuGovernorWriter(writeCpuGovernor)
  if not writer.isNil: cpuModeWriter = writer
  cpuModeSudo = CpuGovernorSudo(sudoWriteCpuGovernor)
  if not sudo.isNil: cpuModeSudo = sudo

proc cpuModeRootNow(): string {.gcsafe.} =
  {.gcsafe.}:
    withLock cpuModeLock:
      result = cpuModeRoot

proc alreadySaidUnavailable(governor: string, mark: bool): bool {.gcsafe.} =
  {.gcsafe.}:
    withLock cpuModeLock:
      result = cpuModeUnavailableSaid == governor
      if mark:
        cpuModeUnavailableSaid = governor

proc applyCpuModeNow*(mode: string, root: string): JsonNode {.gcsafe.} =
  ## Applies `mode` under `root` now, on this thread, and says what happened
  ## as a log line (nil when there was nothing to do or to say). May wait on
  ## the privileged door: the runtime calls applyCpuMode instead.
  let plan = planCpuGovernor(mode, root)
  if plan.policies.len == 0:
    return nil
  if plan.toWrite.len == 0:
    if plan.unavailable.len > 0 and not alreadySaidUnavailable(plan.governor, mark = true):
      var offered = newJArray()
      for name in plan.policies[0].available:
        offered.add(%name)
      return %*{"event": "cpu:governor:unavailable", "cpuMode": plan.mode,
        "governor": plan.governor, "available": offered,
        "message": "The kernel does not offer the " & plan.governor &
          " governor here; the processor speed is left as it is."}
    return nil
  result = %*{"event": "cpu:governor", "cpuMode": plan.mode, "governor": plan.governor,
    "previous": plan.policies[0].governor}
  var failed: seq[string] = @[]
  var lastProblem = ""
  {.gcsafe.}:
    for dir in plan.toWrite:
      let problem = cpuModeWriter(dir, plan.governor)
      if problem.len > 0:
        failed.add(dir)
        lastProblem = problem
  if failed.len == 0:
    result["via"] = %"direct"
  elif privilegedDoorAvailable():
    let res = requestPrivileged(pvSetCpuGovernor, %*{"governor": plan.governor}, timeoutMs = 30_000)
    result["via"] = %"door"
    if not res.ok:
      result["event"] = %"cpu:governor:error"
      result["error"] = %res.error
      return
  elif not runningAsRoot():
    var problems: seq[string] = @[]
    {.gcsafe.}:
      for dir in failed:
        let problem = cpuModeSudo(dir, plan.governor)
        if problem.len > 0:
          problems.add(problem)
    result["via"] = %"sudo"
    if problems.len > 0:
      result["event"] = %"cpu:governor:error"
      result["error"] = %(lastProblem & "; sudo: " & problems[^1])
      return
  else:
    result["event"] = %"cpu:governor:error"
    result["error"] = %lastProblem
    return
  # The unavailable note is about one governor: a later change that works
  # may be followed by one that does not, which is said again.
  discard alreadySaidUnavailable("", mark = true)
  let mhz = cpuMhzNow(root)
  if mhz > 0:
    result["mhz"] = %mhz

proc cpuModeWorker() {.thread.} =
  while true:
    var mode = ""
    var root = ""
    {.gcsafe.}:
      withLock cpuModeLock:
        if cpuModeWanted.len == 0:
          cpuModeWorkerRunning = false
          return
        mode = cpuModeWanted
        root = cpuModeRoot
        cpuModeWanted = ""
    try:
      let line = applyCpuModeNow(mode, root)
      if line != nil:
        log(line)
    except CatchableError as error:
      log(%*{"event": "cpu:governor:error", "cpuMode": mode, "error": error.msg})

proc applyCpuMode*(mode: string) {.gcsafe.} =
  ## The frame's `cpuMode`, made the governor: at start and on every reload.
  ## Returns at once; a write goes to a thread of its own. Only values cross:
  ## the mode as a string, never the config.
  when defined(linux):
    let root = cpuModeRootNow()
    if root.len == 0:
      return
    let plan = planCpuGovernor(mode, root)
    if plan.policies.len == 0:
      return
    if plan.toWrite.len == 0 and
        (plan.unavailable.len == 0 or alreadySaidUnavailable(plan.governor, mark = false)):
      return
    var start = false
    var joinFirst = false
    {.gcsafe.}:
      withLock cpuModeLock:
        cpuModeWanted = plan.mode
        if not cpuModeWorkerRunning:
          cpuModeWorkerRunning = true
          start = true
          joinFirst = cpuModeThreadStarted
          cpuModeThreadStarted = true
      if start:
        # The last worker said it was done before it returned: this join is
        # its last few instructions at most.
        if joinFirst:
          joinThread(cpuModeThread)
        createThread(cpuModeThread, cpuModeWorker)
  else:
    discard mode

proc waitForCpuModeForTest*() =
  ## Until the worker (if any) has applied everything asked of it.
  while true:
    var running = false
    withLock cpuModeLock:
      running = cpuModeWorkerRunning
    if not running:
      break
    sleep(5)
  var started = false
  withLock cpuModeLock:
    started = cpuModeThreadStarted
  if started:
    joinThread(cpuModeThread)
    withLock cpuModeLock:
      cpuModeThreadStarted = false

proc cpuModeReport*(mode: string): JsonNode =
  ## The hardware report's half (cloud/enrollment.nim hardwarePayload), as an
  ## ESP32 reports it: the setting, and where cpufreq says, the clock now
  ## and the governor running it.
  result = %*{"cpuMode": normalizeCpuMode(mode)}
  let root = cpuModeRootNow()
  if root.len == 0:
    return
  let mhz = cpuMhzNow(root)
  if mhz > 0:
    result["cpuMhz"] = %mhz
  let governor = cpuGovernorNow(root)
  if governor.len > 0:
    result["cpuGovernor"] = %governor

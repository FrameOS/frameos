## The processor speed on a Linux frame (cpu_governor.nim, cpu_mode_linux.nim):
## the mode → governor map, the privileged door's allow-list, and the ladder
## against a cpufreq tree made in a temp dir. No test here touches the real
## /sys: under -d:testing the runtime's root is "" until a test sets one.

import std/[json, os, strutils, times]
import ../cpu_governor
import ../cpu_mode_linux
import ../privileged
import ../privileged_worker

proc fakeCpufreq(tag: string, governors: openArray[string], available = "conservative ondemand userspace powersave performance",
                 khz = 700000): string =
  ## A cpufreq root with one policy per governor given.
  result = getTempDir() / ("frameos-cpufreq-" & tag & "-" & $epochTime().int64)
  removeDir(result)
  createDir(result)
  for i, governor in governors:
    let dir = result / ("policy" & $i)
    createDir(dir)
    writeFile(dir / "scaling_governor", governor & "\n")
    writeFile(dir / "scaling_available_governors", available & " \n")
    writeFile(dir / "scaling_cur_freq", $khz & "\n")

proc governorOf(root: string, policy = 0): string =
  readFile(root / ("policy" & $policy) / "scaling_governor").strip()

block mode_to_governor:
  doAssert governorForCpuMode("auto") == "ondemand"
  doAssert governorForCpuMode("battery") == "powersave"
  doAssert governorForCpuMode("performance") == "performance"
  # A frame.json from before the setting, or a word the contract does not
  # know, is auto: a Pi frame is on mains power.
  doAssert governorForCpuMode("") == "ondemand"
  doAssert governorForCpuMode("turbo") == "ondemand"
  doAssert normalizeCpuMode(" Performance ") == "performance"
  doAssert normalizeCpuMode("ondemand") == "auto", "a governor's name is no mode"
  for mode in CpuModes:
    doAssert isCpuGovernor(governorForCpuMode(mode)), "every mode maps onto the allow-list"

block allow_list:
  for governor in ["powersave", "ondemand", "performance"]:
    doAssert isCpuGovernor(governor)
  for name in ["", "userspace", "conservative", "schedutil", "ondemand\n", "../ondemand", "performance; reboot"]:
    doAssert not isCpuGovernor(name), name
  doAssert isCpuPolicyName("policy0")
  doAssert isCpuPolicyName("policy12")
  for name in ["policy", "policyX", "policy0/../..", "cpu0", "policy-1", ""]:
    doAssert not isCpuPolicyName(name), name

block door_validation:
  doAssert validatePrivilegedArgs(pvSetCpuGovernor, %*{"governor": "ondemand"}) == ""
  doAssert validatePrivilegedArgs(pvSetCpuGovernor, %*{"governor": "performance"}) == ""
  doAssert validatePrivilegedArgs(pvSetCpuGovernor, %*{"governor": "userspace"}).len > 0,
    "only what cpu_mode maps to"
  doAssert validatePrivilegedArgs(pvSetCpuGovernor, %*{"governor": "/etc/shadow"}).len > 0
  doAssert validatePrivilegedArgs(pvSetCpuGovernor, %*{}).len > 0
  doAssert validatePrivilegedArgs(pvSetCpuGovernor, %*{"governor": "ondemand", "path": "/etc/passwd"}).len > 0,
    "the worker picks the files, never the request"
  doAssert parsePrivilegedVerb("set-cpu-governor") == pvSetCpuGovernor

block plan_reads_sysfs:
  let root = fakeCpufreq("plan", ["powersave", "ondemand"])
  let plan = planCpuGovernor("auto", root)
  doAssert plan.governor == "ondemand"
  doAssert plan.policies.len == 2
  doAssert plan.toWrite == @[root / "policy0"], "only the policy that runs another governor"
  doAssert plan.unavailable.len == 0
  doAssert cpuMhzNow(root) == 700
  doAssert cpuGovernorNow(root) == "powersave"
  # No cpufreq: nothing to plan, nothing to say.
  doAssert planCpuGovernor("performance", root / "missing").policies.len == 0
  doAssert cpuMhzNow(root / "missing") == 0
  removeDir(root)

block root_writes_only_allow_listed_governors:
  let root = fakeCpufreq("root", ["powersave", "powersave"])
  # A policy dir next to them that is not one is never written.
  createDir(root / "boost")
  writeFile(root / "boost" / "scaling_governor", "untouched")
  let outcome = setCpuGovernorAsRoot("ondemand", root)
  doAssert outcome.ok, outcome.message
  doAssert governorOf(root, 0) == "ondemand"
  doAssert governorOf(root, 1) == "ondemand"
  doAssert readFile(root / "boost" / "scaling_governor") == "untouched"
  let refused = setCpuGovernorAsRoot("userspace", root)
  doAssert not refused.ok
  doAssert governorOf(root, 0) == "ondemand", "a refused name writes nothing"
  doAssert writeCpuGovernor(root / "boost", "performance").len > 0, "only a policy's file"
  doAssert not setCpuGovernorAsRoot("ondemand", root / "missing").ok
  removeDir(root)

block root_leaves_a_governor_the_kernel_lacks:
  # intel_pstate offers two governors: ondemand is not one of them.
  let root = fakeCpufreq("pstate", ["powersave"], available = "performance powersave")
  let outcome = setCpuGovernorAsRoot("ondemand", root)
  doAssert not outcome.ok
  doAssert "does not offer" in outcome.message
  doAssert governorOf(root) == "powersave"
  removeDir(root)

block worker_executes_the_verb:
  # The worker writes under the real root, which a test cannot have: the
  # refusal of a name off the list is what can be checked here.
  let res = executePrivilegedRequest(PrivilegedRequest(id: "g1", verb: pvSetCpuGovernor,
    args: %*{"governor": "userspace"}))
  doAssert not res.ok

block ladder_direct:
  let root = fakeCpufreq("direct", ["powersave"])
  let line = applyCpuModeNow("performance", root)
  doAssert line != nil
  doAssert line["event"].getStr() == "cpu:governor", $line
  doAssert line["via"].getStr() == "direct"
  doAssert line["governor"].getStr() == "performance"
  doAssert line["previous"].getStr() == "powersave"
  doAssert line["mhz"].getInt() == 700
  doAssert governorOf(root) == "performance"
  # Already set: nothing to do, nothing to say.
  doAssert applyCpuModeNow("performance", root) == nil
  removeDir(root)

block ladder_unavailable_said_once:
  let root = fakeCpufreq("once", ["powersave"], available = "performance powersave")
  setCpuModeHooksForTest(root)
  let first = applyCpuModeNow("auto", root)
  doAssert first != nil and first["event"].getStr() == "cpu:governor:unavailable", $first
  doAssert first["available"].len == 2
  doAssert applyCpuModeNow("auto", root) == nil, "said once"
  doAssert governorOf(root) == "powersave", "left as it is"
  # A mode it does offer still applies.
  doAssert applyCpuModeNow("performance", root)["via"].getStr() == "direct"
  setCpuModeHooksForTest("")
  removeDir(root)

block ladder_door:
  # Not root, the policy files are root's: the privileged door does it.
  let root = fakeCpufreq("door", ["powersave"])
  var asked: seq[JsonNode] = @[]
  setCpuModeHooksForTest(root,
    writer = proc(policyDir, governor: string): string {.gcsafe.} = "Permission denied",
    sudo = proc(policyDir, governor: string): string {.gcsafe.} = "sudo must not be tried")
  setPrivilegedRequestHookForTest(proc(request: PrivilegedRequest): PrivilegedResult {.gcsafe.} =
    {.gcsafe.}:
      asked.add(%*{"verb": $request.verb, "args": request.args})
    privilegedOk("ok"))
  let line = applyCpuModeNow("auto", root)
  doAssert line["event"].getStr() == "cpu:governor", $line
  doAssert line["via"].getStr() == "door"
  doAssert asked.len == 1
  doAssert asked[0]["verb"].getStr() == "set-cpu-governor"
  doAssert asked[0]["args"] == %*{"governor": "ondemand"}, "the governor and nothing else"
  # A door that refuses is an error line, never a raise.
  setPrivilegedRequestHookForTest(proc(request: PrivilegedRequest): PrivilegedResult {.gcsafe.} =
    privilegedError("the kernel does not offer ondemand"))
  let refused = applyCpuModeNow("auto", root)
  doAssert refused["event"].getStr() == "cpu:governor:error", $refused
  doAssert "does not offer" in refused["error"].getStr()
  resetPrivilegedRequestHookForTest()
  setCpuModeHooksForTest("")
  removeDir(root)

block ladder_sudo:
  # Not root, no door (Raspberry Pi OS's `pi`): sudo -n, when this test is
  # not itself root (then the direct write is all there is).
  let root = fakeCpufreq("sudo", ["ondemand"])
  var sudoed: seq[string] = @[]
  setCpuModeHooksForTest(root,
    writer = proc(policyDir, governor: string): string {.gcsafe.} = "Permission denied",
    sudo = proc(policyDir, governor: string): string {.gcsafe.} =
      {.gcsafe.}:
        sudoed.add(policyDir.lastPathPart & "=" & governor)
      "")
  let line = applyCpuModeNow("battery", root)
  if runningAsRoot():
    doAssert line["event"].getStr() == "cpu:governor:error"
  else:
    doAssert line["via"].getStr() == "sudo", $line
    doAssert sudoed == @["policy0=powersave"]
  setCpuModeHooksForTest("")
  removeDir(root)

block apply_runs_on_its_own_thread:
  let root = fakeCpufreq("thread", ["powersave", "powersave"])
  setCpuModeHooksForTest(root)
  applyCpuMode("performance")
  waitForCpuModeForTest()
  doAssert governorOf(root, 0) == "performance"
  doAssert governorOf(root, 1) == "performance"
  # Again, with nothing to change: no thread at all.
  applyCpuMode("performance")
  waitForCpuModeForTest()
  applyCpuMode("auto")
  waitForCpuModeForTest()
  doAssert governorOf(root, 0) == "ondemand"
  let report = cpuModeReport("auto")
  doAssert report["cpuMode"].getStr() == "auto"
  doAssert report["cpuMhz"].getInt() == 700
  doAssert report["cpuGovernor"].getStr() == "ondemand"
  setCpuModeHooksForTest("")
  removeDir(root)

block testing_never_touches_the_machine:
  # The default root under -d:testing is "": no plan, no report beyond the
  # setting, whatever the machine running the test has in /sys.
  setCpuModeHooksForTest("")
  applyCpuMode("performance")
  waitForCpuModeForTest()
  doAssert cpuModeReport("battery") == %*{"cpuMode": "battery"}

echo "test_cpu_governor: ok"

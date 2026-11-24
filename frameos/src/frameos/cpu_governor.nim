## The processor speed of a Linux frame, the kernel's half: the contract's
## `cpu_mode` (docs/cloud-frames-contract.json, frame.json
## `deviceConfig.cpuMode`) as a cpufreq governor, and the one write root
## makes for it.
##
## An ESP32 sets its chip's clock at boot (embedded/esp32/main/main.c). A
## Pi's clock is cpufreq's, and FrameOS picks the governor:
##
##   battery      powersave    the lowest clock, always
##   performance  performance  the highest clock, always
##   auto         ondemand     the highest while busy, the lowest while idle
##
## A Pi frame is on mains power, so `auto` is ondemand: what a Buildroot
## image boots with since its cmdline.txt carries
## `cpufreq.default_governor=ondemand` (docs/boot-partition.md). An image
## from before that line boots on the Pi kernel's powersave (a Pi Zero W at
## 700 MHz of 1000, a Pi 5 at 1.5 GHz of 2.4), and on that Zero W a video
## decoded about 28 % faster on ondemand (2026-11-24): the runtime setting
## the governor at start is what moves the frames already flashed.
##
## Pure and root-safe: no logging, no privileges asked for, nothing spawned.
## The runtime's half (when to apply, the privileged door, `sudo -n`, the
## report) is cpu_mode_linux.nim; the privileged worker calls
## `setCpuGovernorAsRoot` below, and privileged.nim validates the door's
## argument with `isCpuGovernor`, so the names root may write are this list
## and no other.

import std/[algorithm, os, strutils]

const
  CpufreqRoot* = "/sys/devices/system/cpu/cpufreq"
  ## The contract's `cpu_mode` enum.
  CpuModes* = ["auto", "battery", "performance"]
  ## Every governor FrameOS ever writes: what governorForCpuMode answers.
  ## The privileged door refuses any other name.
  CpuGovernors* = ["powersave", "ondemand", "performance"]

type
  CpuPolicy* = object
    ## One cpufreq policy (a group of cores that share a clock; a Pi has
    ## one): its directory, its governor now and the governors it offers.
    dir*: string
    governor*: string
    available*: seq[string]

  CpuGovernorPlan* = object
    ## What applying a mode would do, read off sysfs.
    mode*: string                 ## the mode, normalized ("" for a bare governor)
    governor*: string             ## the governor it asks for
    policies*: seq[CpuPolicy]     ## every policy; empty without cpufreq
    toWrite*: seq[string]         ## policy dirs that offer it and run another
    unavailable*: seq[string]     ## policy dirs that do not offer it

proc normalizeCpuMode*(mode: string): string =
  ## A mode the contract names, else `auto` (an older frame.json has none).
  let lowered = mode.strip().toLowerAscii()
  if lowered in CpuModes: lowered else: "auto"

proc governorForCpuMode*(mode: string): string =
  case normalizeCpuMode(mode)
  of "battery": "powersave"
  of "performance": "performance"
  else: "ondemand"

proc isCpuGovernor*(name: string): bool =
  ## One of the governors FrameOS writes: the door's allow-list.
  name in CpuGovernors

proc isCpuPolicyName*(name: string): bool =
  ## `policy<N>`, a cpufreq policy directory's name, and nothing else.
  const prefix = "policy"
  name.len > prefix.len and name.startsWith(prefix) and
    name[prefix.len .. ^1].allCharsInSet(Digits)

proc readSysText(path: string): string =
  try:
    readFile(path).strip()
  except CatchableError:
    ""

proc cpuPolicyDirs*(root = CpufreqRoot): seq[string] =
  ## The policy directories under `root`, in order; empty without cpufreq (a
  ## container, a desktop that has none). Directories only: a policy is never
  ## a link in sysfs, and root follows nothing it did not find here.
  if root.len == 0 or not dirExists(root):
    return
  try:
    for kind, path in walkDir(root):
      if kind == pcDir and isCpuPolicyName(path.lastPathPart):
        result.add(path)
  except OSError:
    discard
  result.sort(proc(a, b: string): int =
    let left = try: parseInt(a.lastPathPart["policy".len .. ^1]) except ValueError: 0
    let right = try: parseInt(b.lastPathPart["policy".len .. ^1]) except ValueError: 0
    cmp(left, right))

proc readCpuPolicy*(dir: string): CpuPolicy =
  result.dir = dir
  result.governor = readSysText(dir / "scaling_governor")
  for name in readSysText(dir / "scaling_available_governors").splitWhitespace():
    result.available.add(name)

proc readCpuPolicies*(root = CpufreqRoot): seq[CpuPolicy] =
  for dir in cpuPolicyDirs(root):
    result.add(readCpuPolicy(dir))

proc planGovernor*(governor: string, root = CpufreqRoot): CpuGovernorPlan =
  result.governor = governor
  result.policies = readCpuPolicies(root)
  for policy in result.policies:
    if result.governor notin policy.available:
      result.unavailable.add(policy.dir)
    elif policy.governor != result.governor:
      result.toWrite.add(policy.dir)

proc planCpuGovernor*(mode: string, root = CpufreqRoot): CpuGovernorPlan =
  result = planGovernor(governorForCpuMode(mode), root)
  result.mode = normalizeCpuMode(mode)

proc governorFile*(policyDir: string): string =
  policyDir / "scaling_governor"

proc writeCpuGovernor*(policyDir, governor: string): string =
  ## One policy's governor, written as the process is: "" when it took,
  ## else why not. Only a governor of the allow-list, only a policy's file.
  if not isCpuGovernor(governor):
    return "not a governor FrameOS sets: " & governor
  if not isCpuPolicyName(policyDir.lastPathPart):
    return "not a cpufreq policy: " & policyDir
  try:
    writeFile(governorFile(policyDir), governor)
  except CatchableError as error:
    return error.msg
  ""

proc cpuMhzNow*(root = CpufreqRoot): int =
  ## The first policy's clock now (cpu0's on a Pi), in MHz; 0 when unknown.
  let dirs = cpuPolicyDirs(root)
  if dirs.len == 0:
    return 0
  for name in ["scaling_cur_freq", "cpuinfo_cur_freq"]:
    let text = readSysText(dirs[0] / name)
    if text.len > 0:
      try:
        return int(parseBiggestInt(text) div 1000)
      except ValueError:
        discard
  0

proc cpuGovernorNow*(root = CpufreqRoot): string =
  ## The first policy's governor now; "" without cpufreq.
  let dirs = cpuPolicyDirs(root)
  if dirs.len == 0: "" else: readSysText(governorFile(dirs[0]))

proc setCpuGovernorAsRoot*(governor: string, root = CpufreqRoot): tuple[ok: bool, message: string] =
  ## The privileged door's `set-cpu-governor` (privileged_worker.nim): every
  ## policy under the fixed cpufreq root that offers `governor` and runs
  ## another gets it. Nothing else is written, and nothing is when the name
  ## is not on the allow-list.
  if not isCpuGovernor(governor):
    return (false, "governor must be one of " & CpuGovernors.join(", "))
  let plan = planGovernor(governor, root)
  if plan.policies.len == 0:
    return (false, "no cpufreq policies under " & root)
  if plan.unavailable.len == plan.policies.len:
    return (false, "the kernel does not offer " & governor)
  var problems: seq[string] = @[]
  for dir in plan.toWrite:
    let problem = writeCpuGovernor(dir, governor)
    if problem.len > 0:
      problems.add(dir.lastPathPart & ": " & problem)
  if problems.len > 0:
    return (false, problems.join("; "))
  (true, governor & " on " & $(plan.policies.len - plan.unavailable.len) & " of " &
    $plan.policies.len & " policies")

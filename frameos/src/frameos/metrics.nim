import json, os, strutils, sequtils, posix, sets
import frameos/types
import frameos/channels
import frameos/runtime_diagnostics

type
  MetricsLoggerThread = ref object
    frameConfig: FrameConfig

  ReadFileHook = proc(path: string): string {.gcsafe, nimcall.}
  CpuUsageHook = proc(interval: float): float {.gcsafe, nimcall.}
  SleepHook = proc(ms: int) {.gcsafe, nimcall.}
  MemoryUsageHook = proc(): tuple[total, used: int64, percentage: float] {.gcsafe, nimcall.}
  DiskUsageHook = proc(): JsonNode {.gcsafe, nimcall.}
  OpenFileDescriptorsHook = proc(): int {.gcsafe, nimcall.}
  CpuTimes = tuple[idle, total: uint64]

const noisyDiskFsTypes = [
  "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs",
  "devpts", "devtmpfs", "efivarfs", "fusectl", "hugetlbfs", "mqueue", "nsfs",
  "overlay", "proc", "pstore", "ramfs", "rpc_pipefs", "securityfs", "squashfs",
  "sysfs", "tmpfs", "tracefs"
]
const systemDiskMounts = ["/boot", "/boot/efi", "/boot/firmware", "/efi", "/recovery"]

var thread: Thread[FrameConfig]
var metricsReadFileHook: ReadFileHook = proc(path: string): string = readFile(path)
var metricsSleepHook: SleepHook = proc(ms: int) = sleep(ms)
var metricsOpenFileDescriptorsHook: OpenFileDescriptorsHook = proc(): int =
  var fdCount = 0
  let dir = "/proc/" & $getpid() & "/fd"
  for _ in walkDir(dir):
    inc(fdCount)
  fdCount

proc parseCpuTimes(line: string): CpuTimes =
  let parts = line.splitWhitespace()
  if parts.len < 5 or parts[0] != "cpu":
    return (0'u64, 0'u64)

  for index in 1 ..< parts.len:
    result.total += parseBiggestUInt(parts[index]).uint64
  result.idle = parseBiggestUInt(parts[4]).uint64
  if parts.len > 5:
    result.idle += parseBiggestUInt(parts[5]).uint64

proc readCpuTimes(): CpuTimes =
  try:
    let lines = metricsReadFileHook("/proc/stat").splitLines()
    if lines.len > 0:
      return parseCpuTimes(lines[0])
  except CatchableError:
    discard
  (0'u64, 0'u64)

proc defaultCpuCount(): int =
  try:
    for line in metricsReadFileHook("/proc/stat").splitLines():
      let parts = line.splitWhitespace()
      if parts.len == 0:
        continue
      let name = parts[0]
      if name.len > 3 and name.startsWith("cpu") and name[3].isDigit:
        inc result
  except CatchableError:
    discard
  max(result, 1)

proc defaultCpuUsage(interval: float): float =
  let start = readCpuTimes()
  let ms = max(0, (interval * 1000.0).int)
  if ms > 0:
    metricsSleepHook(ms)
  let finish = readCpuTimes()
  if finish.total <= start.total or finish.idle < start.idle:
    return 0.0

  let totalDelta = finish.total - start.total
  if totalDelta == 0:
    return 0.0

  let idleDelta = finish.idle - start.idle
  ((totalDelta - idleDelta).float / totalDelta.float) * 100.0

proc parseMeminfoBytes(line: string): int64 =
  let parts = line.splitWhitespace()
  if parts.len < 2:
    return 0
  parseBiggestInt(parts[1]).int64 * 1024

proc defaultMemoryUsage(): tuple[total, used: int64, percentage: float] =
  var available: int64 = 0
  try:
    for line in metricsReadFileHook("/proc/meminfo").splitLines():
      if line.startsWith("MemTotal:"):
        result.total = parseMeminfoBytes(line)
      elif line.startsWith("MemAvailable:"):
        available = parseMeminfoBytes(line)
  except CatchableError:
    discard

  if result.total > 0:
    result.used = max(0'i64, result.total - available)
    result.percentage = (result.used.float / result.total.float) * 100.0
  else:
    result.percentage = 0.0

proc defaultProcessMemoryUsage*(): JsonNode =
  let pid = getpid()
  result = newJObject()
  try:
    for line in metricsReadFileHook("/proc/" & $pid & "/status").splitLines():
      if line.startsWith("VmRSS:"):
        result["rss"] = %(parseMeminfoBytes(line))
      elif line.startsWith("VmHWM:"):
        result["peakRss"] = %(parseMeminfoBytes(line))
      elif line.startsWith("VmSize:"):
        result["virtual"] = %(parseMeminfoBytes(line))
      elif line.startsWith("VmData:"):
        result["data"] = %(parseMeminfoBytes(line))
      elif line.startsWith("VmStk:"):
        result["stack"] = %(parseMeminfoBytes(line))
      elif line.startsWith("VmSwap:"):
        result["swap"] = %(parseMeminfoBytes(line))
      elif line.startsWith("RssAnon:"):
        result["rssAnon"] = %(parseMeminfoBytes(line))
      elif line.startsWith("RssFile:"):
        result["rssFile"] = %(parseMeminfoBytes(line))
      elif line.startsWith("RssShmem:"):
        result["rssShmem"] = %(parseMeminfoBytes(line))
  except CatchableError:
    discard

proc decodeMountField(value: string): string =
  result = value
  result = result.replace("\\040", " ")
  result = result.replace("\\011", "\t")
  result = result.replace("\\012", "\n")
  result = result.replace("\\134", "\\")

proc isDiskMount(device, mount, fsType: string): bool =
  if mount.len == 0 or not mount.startsWith("/"):
    return false
  for systemMount in systemDiskMounts:
    if mount == systemMount or mount.startsWith(systemMount & "/"):
      return false
  if fsType in noisyDiskFsTypes or fsType.startsWith("fuse."):
    return false
  device.startsWith("/dev/") or device == "rootfs" or device.startsWith("UUID=") or device.startsWith("LABEL=")

proc getMountDiskUsage(mount: string): tuple[total, used, available: int64, percentage: float] =
  let fd = open(mount.cstring, O_RDONLY)
  if fd < 0:
    return (0'i64, 0'i64, 0'i64, 0.0)
  try:
    var stats: StatVfs
    if fstatvfs(fd, stats) != 0:
      return (0'i64, 0'i64, 0'i64, 0.0)

    result.total = (stats.f_blocks * stats.f_frsize).int64
    let free = (stats.f_bfree * stats.f_frsize).int64
    result.available = (stats.f_bavail * stats.f_frsize).int64
    result.used = max(0'i64, result.total - free)
    if result.total > 0:
      result.percentage = (result.used.float / result.total.float) * 100.0
  finally:
    discard close(fd)

proc defaultDiskUsage(): JsonNode =
  var total = 0'i64
  var used = 0'i64
  var available = 0'i64
  var filesystems = newJArray()
  var seen = initHashSet[string]()

  try:
    for line in metricsReadFileHook("/proc/mounts").splitLines():
      let parts = line.splitWhitespace()
      if parts.len < 3:
        continue

      let device = decodeMountField(parts[0])
      let mount = decodeMountField(parts[1])
      let fsType = parts[2]
      if not isDiskMount(device, mount, fsType):
        continue

      let identity = device & "\0" & mount
      if seen.contains(identity):
        continue
      seen.incl(identity)

      let usage = getMountDiskUsage(mount)
      if usage.total <= 0:
        continue

      total += usage.total
      used += usage.used
      available += usage.available
      filesystems.add(%*{
        "mount": mount,
        "device": device,
        "type": fsType,
        "total": usage.total,
        "used": usage.used,
        "available": usage.available,
        "percentage": usage.percentage,
      })
  except CatchableError:
    discard

  result = newJObject()
  if total > 0:
    result["total"] = %total
    result["used"] = %used
    result["available"] = %available
    result["percentage"] = %((used.float / total.float) * 100.0)
    result["filesystems"] = filesystems

var metricsCpuUsageHook: CpuUsageHook = proc(interval: float): float = defaultCpuUsage(interval)
var metricsMemoryUsageHook: MemoryUsageHook = proc(): tuple[total, used: int64, percentage: float] = defaultMemoryUsage()
var metricsDiskUsageHook: DiskUsageHook = proc(): JsonNode = defaultDiskUsage()

proc getLoadAverage(self: MetricsLoggerThread): seq[float] =
  try:
    let cpuTempLine = metricsReadFileHook("/proc/loadavg")
    result = cpuTempLine.split(" ")[0..2].map(parseFloat)
  except IOError:
    result = @[]

proc getCPUTemperature(self: MetricsLoggerThread): float =
  try:
    let cpuTempLine = metricsReadFileHook("/sys/class/thermal/thermal_zone0/temp")
    result = parseFloat(cpuTempLine.strip()) / 1000.0
  except IOError:
    result = 0.0

proc getMemoryUsage(self: MetricsLoggerThread): JsonNode =
  let memoryInfo = metricsMemoryUsageHook()
  result = %*{
    "total": memoryInfo.total,
    "used": memoryInfo.used,
    "percentage": memoryInfo.percentage,
  }

proc getDiskUsage(self: MetricsLoggerThread): JsonNode =
  metricsDiskUsageHook()

proc getCPUUsage(self: MetricsLoggerThread): float =
  result = metricsCpuUsageHook(1.0)

proc getCPUCount(self: MetricsLoggerThread): int =
  defaultCpuCount()

proc getOpenFileDescriptors(self: MetricsLoggerThread): int =
  metricsOpenFileDescriptorsHook()

proc getProcessMemoryUsage*(self: MetricsLoggerThread): JsonNode =
  defaultProcessMemoryUsage()

proc logMetrics(self: MetricsLoggerThread) =
  var payload = %*{
    "event": "metrics",
    "load": self.getLoadAverage(),
    "cpuTemperature": self.getCPUTemperature(),
    "memoryUsage": self.getMemoryUsage(),
    "diskUsage": self.getDiskUsage(),
    "processMemory": self.getProcessMemoryUsage(),
    "cpuUsage": self.getCPUUsage(),
    "cpuCount": self.getCPUCount(),
    "openFileDescriptors": self.getOpenFileDescriptors(),
    "runtime": runtimeDiagnosticsSnapshot(),
  }
  log(payload)

proc runMetricsLoop(self: MetricsLoggerThread, maxIterations = -1) {.gcsafe.} =
  let ms = (self.frameConfig.metricsInterval * 1000).int
  if ms == 0:
    log(%*{"event": "metrics", "state": "disabled"})
  else:
    var iterations = 0
    while true:
      if maxIterations >= 0 and iterations >= maxIterations:
        break
      inc iterations
      try:
        self.logMetrics()
      except Exception as e:
        log(%*{
          "event": "metrics",
          "state": "error",
          "error": e.msg,
        })
      metricsSleepHook(ms)

proc start(self: MetricsLoggerThread) {.gcsafe.} =
  self.runMetricsLoop()

proc createThreadRunner(frameConfig: FrameConfig) {.thread.} =
  var metricsLoggerThread = MetricsLoggerThread(
    frameConfig: frameConfig,
  )
  metricsLoggerThread.start()

proc newMetricsLogger*(frameConfig: FrameConfig): MetricsLogger =
  createThread(thread, createThreadRunner, frameConfig)
  result = MetricsLogger(
    frameConfig: frameConfig,
  )

proc setMetricsHooksForTest*(
  readFileHook: ReadFileHook = nil,
  cpuUsageHook: CpuUsageHook = nil,
  sleepHook: SleepHook = nil,
  memoryUsageHook: MemoryUsageHook = nil,
  diskUsageHook: DiskUsageHook = nil,
  openFileDescriptorsHook: OpenFileDescriptorsHook = nil
) =
  if readFileHook != nil: metricsReadFileHook = readFileHook
  if cpuUsageHook != nil: metricsCpuUsageHook = cpuUsageHook
  if sleepHook != nil: metricsSleepHook = sleepHook
  if memoryUsageHook != nil: metricsMemoryUsageHook = memoryUsageHook
  if diskUsageHook != nil: metricsDiskUsageHook = diskUsageHook
  if openFileDescriptorsHook != nil: metricsOpenFileDescriptorsHook = openFileDescriptorsHook

proc resetMetricsHooksForTest*() =
  metricsReadFileHook = proc(path: string): string = readFile(path)
  metricsCpuUsageHook = proc(interval: float): float = defaultCpuUsage(interval)
  metricsSleepHook = proc(ms: int) = sleep(ms)
  metricsMemoryUsageHook = proc(): tuple[total, used: int64, percentage: float] = defaultMemoryUsage()
  metricsDiskUsageHook = proc(): JsonNode = defaultDiskUsage()
  metricsOpenFileDescriptorsHook = proc(): int =
    var fdCount = 0
    let dir = "/proc/" & $getpid() & "/fd"
    for _ in walkDir(dir):
      inc(fdCount)
    fdCount

proc runMetricsLoopForTest*(frameConfig: FrameConfig, iterations: int) =
  var metricsLoggerThread = MetricsLoggerThread(frameConfig: frameConfig)
  metricsLoggerThread.runMetricsLoop(maxIterations = iterations)

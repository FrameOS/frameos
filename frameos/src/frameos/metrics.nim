import json, os, psutil, strutils, sequtils, posix
import frameos/types
import frameos/channels

type
  MetricsLoggerThread = ref object
    frameConfig: FrameConfig

  ReadFileHook = proc(path: string): string {.gcsafe, nimcall.}
  CpuUsageHook = proc(interval: float): float {.gcsafe, nimcall.}
  SleepHook = proc(ms: int) {.gcsafe, nimcall.}
  MemoryUsageHook = proc(): tuple[total, available: int64, percentage: float] {.gcsafe, nimcall.}
  OpenFileDescriptorsHook = proc(): int {.gcsafe, nimcall.}

var thread: Thread[FrameConfig]
var metricsReadFileHook: ReadFileHook = proc(path: string): string = readFile(path)
var metricsCpuUsageHook: CpuUsageHook = proc(interval: float): float = psutil.cpuPercent(interval = interval)
var metricsSleepHook: SleepHook = proc(ms: int) = sleep(ms)
var metricsMemoryUsageHook: MemoryUsageHook = proc(): tuple[total, available: int64, percentage: float] =
  let memoryInfo = psutil.virtualMemory()
  (memoryInfo.total, memoryInfo.avail, memoryInfo.percent)
var metricsOpenFileDescriptorsHook: OpenFileDescriptorsHook = proc(): int =
  var fdCount = 0
  let dir = "/proc/" & $getpid() & "/fd"
  for _ in walkDir(dir):
    inc(fdCount)
  fdCount

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
    "available": memoryInfo.available,
    "percentage": memoryInfo.percentage,
  }

proc getCPUUsage(self: MetricsLoggerThread): float =
  result = metricsCpuUsageHook(1.0)

proc getOpenFileDescriptors(self: MetricsLoggerThread): int =
  metricsOpenFileDescriptorsHook()

proc logMetrics(self: MetricsLoggerThread) =
  log(%*{
    "event": "metrics",
    "load": self.getLoadAverage(),
    "cpuTemperature": self.getCPUTemperature(),
    "memoryUsage": self.getMemoryUsage(),
    "cpuUsage": self.getCPUUsage(),
    "openFileDescriptors": self.getOpenFileDescriptors(),
  })

proc runMetricsLoop(self: MetricsLoggerThread, maxIterations = -1) {.gcsafe.} =
  let ms = (self.frameConfig.metricsInterval * 1000).int
  if ms == 0:
    log(%*{"event": "metrics", "state": "disabled"})
  else:
    log(%*{"event": "metrics", "state": "enabled", "intervalMs": ms})
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
  openFileDescriptorsHook: OpenFileDescriptorsHook = nil
) =
  if readFileHook != nil: metricsReadFileHook = readFileHook
  if cpuUsageHook != nil: metricsCpuUsageHook = cpuUsageHook
  if sleepHook != nil: metricsSleepHook = sleepHook
  if memoryUsageHook != nil: metricsMemoryUsageHook = memoryUsageHook
  if openFileDescriptorsHook != nil: metricsOpenFileDescriptorsHook = openFileDescriptorsHook

proc resetMetricsHooksForTest*() =
  metricsReadFileHook = proc(path: string): string = readFile(path)
  metricsCpuUsageHook = proc(interval: float): float = psutil.cpuPercent(interval = interval)
  metricsSleepHook = proc(ms: int) = sleep(ms)
  metricsMemoryUsageHook = proc(): tuple[total, available: int64, percentage: float] =
    let memoryInfo = psutil.virtualMemory()
    (memoryInfo.total, memoryInfo.avail, memoryInfo.percent)
  metricsOpenFileDescriptorsHook = proc(): int =
    var fdCount = 0
    let dir = "/proc/" & $getpid() & "/fd"
    for _ in walkDir(dir):
      inc(fdCount)
    fdCount

proc runMetricsLoopForTest*(frameConfig: FrameConfig, iterations: int) =
  var metricsLoggerThread = MetricsLoggerThread(frameConfig: frameConfig)
  metricsLoggerThread.runMetricsLoop(maxIterations = iterations)

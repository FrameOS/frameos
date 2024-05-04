import json, os, psutil, strutils, sequtils, posix
import frameos/types
import frameos/channels

type
  MetricsLoggerThread = ref object
    frameConfig: FrameConfig

var thread: Thread[FrameConfig]

proc getLoadAverage(self: MetricsLoggerThread): seq[float] =
  try:
    let cpuTempLine = readFile("/proc/loadavg")
    result = cpuTempLine.split(" ")[0..2].map(parseFloat)
  except IOError:
    result = @[]

proc getCPUTemperature(self: MetricsLoggerThread): float =
  try:
    let cpuTempLine = readFile("/sys/class/thermal/thermal_zone0/temp")
    result = parseFloat(cpuTempLine.strip()) / 1000.0
  except IOError:
    result = 0.0

proc getMemoryUsage(self: MetricsLoggerThread): JsonNode =
  let memoryInfo = psutil.virtualMemory()
  result = %*{
    "total": memoryInfo.total,
    "available": memoryInfo.avail,
    "percentage": memoryInfo.percent,
    "used": memoryInfo.used,
    "free": memoryInfo.free,
    "active": memoryInfo.active,
  }

proc getCPUUsage(self: MetricsLoggerThread): float =
  result = psutil.cpuPercent(interval = 1)

proc getNetConnections(self: MetricsLoggerThread): int =
  let pid = getpid()
  result = net_connections(pid = pid).len

proc logMetrics(self: MetricsLoggerThread) =
  log(%*{
    "event": "metrics",
    "load": self.getLoadAverage(),
    "cpuTemperature": self.getCPUTemperature(),
    "memoryUsage": self.getMemoryUsage(),
    "cpuUsage": self.getCPUUsage(),
    "netConnections": self.getNetConnections(),
  })

proc start(self: MetricsLoggerThread) =
  let ms = (self.frameConfig.metricsInterval * 1000).int
  if ms == 0:
    log(%*{"event": "metrics", "state": "disabled"})
  else:
    log(%*{"event": "metrics", "state": "enabled", "intervalMs": ms})
    while true:
      try:
        self.logMetrics()
      except Exception as e:
        log(%*{
          "event": "metrics",
          "state": "error",
          "error": e.msg,
        })
      sleep(ms)

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

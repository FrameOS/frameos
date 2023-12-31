import json, os, psutil, strutils, sequtils

from frameos/types import FrameConfig, MetricsLogger, Logger

type
  MetricsLoggerThread = ref object
    frameConfig: FrameConfig
    logger: Logger

var
  thread: Thread[Logger]

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

proc logMetrics(self: MetricsLoggerThread) =
  {.gcsafe.}:
    self.logger.log(%*{
      "event": "metrics",
      "load": self.getLoadAverage(),
      "cpuTemperature": self.getCPUTemperature(),
      "memoryUsage": self.getMemoryUsage(),
      "cpuUsage": self.getCPUUsage()
    })

proc start(self: MetricsLoggerThread) =
  let ms = (self.frameConfig.metricsInterval * 1000).int
  if ms == 0:
    {.gcsafe.}:
      self.logger.log(%*{"event": "metrics", "state": "disabled"})
  else:
    {.gcsafe.}:
      self.logger.log(%*{"event": "metrics", "state": "enabled",
          "intervalMs": ms})
    while true:
      try:
        self.logMetrics()
      except Exception as e:
        {.gcsafe.}:
          self.logger.log(%*{
            "event": "metrics",
            "state": "error",
            "error": e.msg,
          })
      sleep(ms)

proc createThreadRunner(logger: Logger) {.thread.} =
  var metricsLoggerThread = MetricsLoggerThread(
    frameConfig: logger.frameConfig,
    logger: logger,
  )
  metricsLoggerThread.start()

proc newMetricsLogger*(logger: Logger): MetricsLogger =
  createThread(thread, createThreadRunner, logger)
  result = MetricsLogger(
    frameConfig: logger.frameConfig,
    logger: logger,
  )

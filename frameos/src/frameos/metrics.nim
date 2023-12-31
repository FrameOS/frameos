import httpclient, zippy, json, sequtils, os, times, strformat

from frameos/types import FrameConfig, MetricsLogger, Logger

type
  MetricsLoggerThread = ref object
    frameConfig: FrameConfig
    logger: Logger

var
  thread: Thread[Logger]

  # def get_load_average(self):
  #     return os.getloadavg()

  # def get_cpu_temperature(self):
  #     try:
  #         with open("/sys/class/thermal/thermal_zone0/temp", "r") as temp_file:
  #             cpu_temp = int(temp_file.read()) / 1000.0
  #         return cpu_temp
  #     except IOError:
  #         return None

  # def get_memory_usage(self):
  #     memory_info = psutil.virtual_memory()
  #     return {
  #         "total": memory_info.total,
  #         "used": memory_info.used,
  #         "free": memory_info.free,
  #         "percentage": memory_info.percent
  #     }

  # def get_cpu_usage(self):
  #     return psutil.cpu_percent(interval=1)

  # def send_metrics_once(self):
  #     metrics = {
  #         'event': '@frame:metrics',
  #         'load': self.get_load_average(),
  #         'cpu_temperature': self.get_cpu_temperature(),
  #         'memory_usage': self.get_memory_usage(),
  #         'cpu_usage': self.get_cpu_usage()
  #     }
  #     self.logger.log(metrics)


proc logMetrics(self: MetricsLoggerThread) =
  discard
  # {.gcsafe.}:
  #   self.logger.log(%*{"event": "metrics"})

proc start(self: MetricsLoggerThread) =
  let ms = (self.frameConfig.metricsInterval * 1000).int
  if ms == 0:
    {.gcsafe.}:
      self.logger.log(%*{"event": "metrics_logger", "state": "disabled"})
  else:
    {.gcsafe.}:
      self.logger.log(%*{"event": "metrics_logger", "state": "enabled", "ms": ms})
    while true:
      self.logMetrics()
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

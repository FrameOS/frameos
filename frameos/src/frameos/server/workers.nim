from std/cpuinfo import countProcessors

const MaxHttpWorkerThreads = 4

proc httpWorkerThreads*(cpuCount: int = countProcessors()): int =
  max(min(cpuCount, MaxHttpWorkerThreads), 1)

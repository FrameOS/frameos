import std/[json, strutils, unittest]

import ../channels
import ../metrics
import ../types

proc drainLogChannel() =
  while true:
    let (ok, _) = logChannel.tryRecv()
    if not ok:
      break

suite "metrics loop":
  setup:
    drainLogChannel()
    resetMetricsHooksForTest()

  teardown:
    resetMetricsHooksForTest()

  test "disabled interval logs disabled state and skips samples":
    runMetricsLoopForTest(FrameConfig(metricsInterval: 0), iterations = 1)

    let (ok, payload) = logChannel.tryRecv()
    check ok
    check payload[1]["event"].getStr() == "metrics"
    check payload[1]["state"].getStr() == "disabled"

    let (hasNext, _) = logChannel.tryRecv()
    check not hasNext

  test "enabled interval logs one metrics sample with hook values":
    setMetricsHooksForTest(
      readFileHook = proc(path: string): string {.gcsafe, nimcall.} =
        if path == "/proc/loadavg":
          "0.10 0.20 0.30 1/123 456\n"
        elif path == "/sys/class/thermal/thermal_zone0/temp":
          "42000\n"
        else:
          raise newException(IOError, "unexpected path"),
      cpuUsageHook = proc(interval: float): float {.gcsafe, nimcall.} = 12.5,
      sleepHook = proc(ms: int) {.gcsafe, nimcall.} = discard,
      memoryUsageHook = proc(): tuple[total, available: int64, percentage: float] {.gcsafe, nimcall.} =
        (1234'i64, 456'i64, 63.0),
      openFileDescriptorsHook = proc(): int {.gcsafe, nimcall.} = 9
    )

    runMetricsLoopForTest(FrameConfig(metricsInterval: 1), iterations = 1)

    let (_, enabledPayload) = logChannel.tryRecv()
    check enabledPayload[1]["state"].getStr() == "enabled"
    check enabledPayload[1]["intervalMs"].getInt() == 1000

    let (okSample, samplePayload) = logChannel.tryRecv()
    check okSample
    check samplePayload[1]["event"].getStr() == "metrics"
    check samplePayload[1]["load"].len == 3
    check abs(samplePayload[1]["cpuTemperature"].getFloat() - 42.0) < 0.0001
    check samplePayload[1]["memoryUsage"]["total"].getInt() == 1234
    check samplePayload[1]["memoryUsage"]["available"].getInt() == 456
    check abs(samplePayload[1]["memoryUsage"]["percentage"].getFloat() - 63.0) < 0.0001
    check abs(samplePayload[1]["cpuUsage"].getFloat() - 12.5) < 0.0001
    check samplePayload[1]["openFileDescriptors"].getInt() == 9

  test "sample exceptions are logged as error state":
    setMetricsHooksForTest(
      readFileHook = proc(path: string): string {.gcsafe, nimcall.} =
        if path == "/proc/loadavg":
          "0.10 0.20 0.30 1/123 456\n"
        elif path == "/sys/class/thermal/thermal_zone0/temp":
          "42000\n"
        else:
          raise newException(IOError, "unexpected path"),
      cpuUsageHook = proc(interval: float): float {.gcsafe, nimcall.} =
        raise newException(ValueError, "cpu probe failed"),
      sleepHook = proc(ms: int) {.gcsafe, nimcall.} = discard
    )

    runMetricsLoopForTest(FrameConfig(metricsInterval: 1), iterations = 1)

    discard logChannel.tryRecv() # enabled message
    let (okError, errorPayload) = logChannel.tryRecv()
    check okError
    check errorPayload[1]["event"].getStr() == "metrics"
    check errorPayload[1]["state"].getStr() == "error"
    check "cpu probe failed" in errorPayload[1]["error"].getStr()

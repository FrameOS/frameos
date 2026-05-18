import std/[json, strutils, unittest]

import ../channels
import ../metrics
import ../runtime_diagnostics
import ../types

proc drainLogChannel() =
  while true:
    let (ok, _) = logChannel.tryRecv()
    if not ok:
      break

proc logJson(payload: (float, string)): JsonNode =
  parseJson(payload[1])

suite "metrics loop":
  setup:
    drainLogChannel()
    resetMetricsHooksForTest()
    resetRuntimeDiagnosticsForTest()

  teardown:
    resetMetricsHooksForTest()
    resetRuntimeDiagnosticsForTest()

  test "disabled interval logs disabled state and skips samples":
    runMetricsLoopForTest(FrameConfig(metricsInterval: 0), iterations = 1)

    let (ok, payload) = logChannel.tryRecv()
    check ok
    let payloadJson = logJson(payload)
    check payloadJson["event"].getStr() == "metrics"
    check payloadJson["state"].getStr() == "disabled"

    let (hasNext, _) = logChannel.tryRecv()
    check not hasNext

  test "enabled interval logs one metrics sample with hook values and no startup placeholder":
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
      memoryUsageHook = proc(): tuple[total, used: int64, percentage: float] {.gcsafe, nimcall.} =
        (1234'i64, 778'i64, 63.0),
      diskUsageHook = proc(): JsonNode {.gcsafe, nimcall.} = %*{
        "total": 16000'i64,
        "used": 8900'i64,
        "available": 7100'i64,
        "percentage": 55.625,
        "filesystems": [
          {
            "mount": "/",
            "device": "/dev/root",
            "type": "ext4",
            "total": 16000'i64,
            "used": 8900'i64,
            "available": 7100'i64,
            "percentage": 55.625,
          }
        ],
      },
      openFileDescriptorsHook = proc(): int {.gcsafe, nimcall.} = 9
    )

    runMetricsLoopForTest(FrameConfig(metricsInterval: 1), iterations = 1)

    let (okSample, samplePayload) = logChannel.tryRecv()
    check okSample
    let sampleJson = logJson(samplePayload)
    check sampleJson["event"].getStr() == "metrics"
    check not sampleJson.hasKey("state")
    check not sampleJson.hasKey("intervalMs")
    check sampleJson["load"].len == 3
    check abs(sampleJson["cpuTemperature"].getFloat() - 42.0) < 0.0001
    check sampleJson["memoryUsage"]["total"].getInt() == 1234
    check sampleJson["memoryUsage"]["used"].getInt() == 778
    check abs(sampleJson["memoryUsage"]["percentage"].getFloat() - 63.0) < 0.0001
    check sampleJson["diskUsage"]["total"].getInt() == 16000
    check sampleJson["diskUsage"]["used"].getInt() == 8900
    check sampleJson["diskUsage"]["available"].getInt() == 7100
    check abs(sampleJson["diskUsage"]["percentage"].getFloat() - 55.625) < 0.0001
    check sampleJson["diskUsage"]["filesystems"].len == 1
    check sampleJson["diskUsage"]["filesystems"][0]["mount"].getStr() == "/"
    check not sampleJson["processMemory"].hasKey("pid")
    check abs(sampleJson["cpuUsage"].getFloat() - 12.5) < 0.0001
    check sampleJson["openFileDescriptors"].getInt() == 9
    check not sampleJson.hasKey("runtime")

  test "enabled interval includes active runtime diagnostics":
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
      memoryUsageHook = proc(): tuple[total, used: int64, percentage: float] {.gcsafe, nimcall.} =
        (1234'i64, 778'i64, 63.0),
      openFileDescriptorsHook = proc(): int {.gcsafe, nimcall.} = 9
    )
    markRuntimeStart("render", "scene-a", "render", 80, 60)
    markRuntimeCheckpoint("node:start", currentSceneId = "scene-b", contextEvent = "render",
      nodeId = 42, nodeType = "app", keyword = "data/demo")

    runMetricsLoopForTest(FrameConfig(metricsInterval: 1, debug: true), iterations = 1)

    let (okSample, samplePayload) = logChannel.tryRecv()
    check okSample
    let runtime = logJson(samplePayload)["runtime"]
    check runtime["active"].getBool() == true
    check runtime["mode"].getStr() == "render"
    check runtime["sceneId"].getStr() == "scene-a"
    check runtime["currentSceneId"].getStr() == "scene-b"
    check runtime["contextEvent"].getStr() == "render"
    check runtime["nodeId"].getInt() == 42
    check runtime["nodeType"].getStr() == "app"
    check runtime["keyword"].getStr() == "data/demo"

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

    let (okError, errorPayload) = logChannel.tryRecv()
    check okError
    let errorJson = logJson(errorPayload)
    check errorJson["event"].getStr() == "metrics"
    check errorJson["state"].getStr() == "error"
    check "cpu probe failed" in errorJson["error"].getStr()

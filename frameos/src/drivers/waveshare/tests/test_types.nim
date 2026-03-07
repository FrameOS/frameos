import std/[json, strutils, unittest]

import ../types
import frameos/types

type LogSink = ref object
  entries: seq[JsonNode]

proc makeLogger(sink: LogSink; debug: bool; withConfig: bool = true): Logger =
  result = Logger(enabled: true)
  if withConfig:
    result.frameConfig = FrameConfig(debug: debug)
  result.log = proc(payload: JsonNode) =
    sink.entries.add(copy(payload))
  result.enable = proc() = discard
  result.disable = proc() = discard

suite "waveshare driver helper types":
  setup:
    clearDriverDebugLogger()

  teardown:
    clearDriverDebugLogger()

  test "debug logger enablement follows logger config":
    let sink = LogSink(entries: @[])

    setDriverDebugLogger(nil)
    check driverDebugLogsEnabled() == false

    setDriverDebugLogger(makeLogger(sink, debug = false))
    check driverDebugLogsEnabled() == false

    setDriverDebugLogger(makeLogger(sink, debug = true))
    check driverDebugLogsEnabled() == true

    clearDriverDebugLogger()
    check driverDebugLogsEnabled() == false

  test "logDriverDebug handles nil and non-object payloads":
    let sink = LogSink(entries: @[])
    setDriverDebugLogger(makeLogger(sink, debug = true))

    logDriverDebug(nil)
    logDriverDebug(%*"plain message")

    check sink.entries.len == 2
    check sink.entries[0]["event"].getStr() == "driver:waveshare:debug"
    check sink.entries[0]["message"].getStr() == "(nil payload)"
    check sink.entries[1]["event"].getStr() == "driver:waveshare:debug"
    check sink.entries[1]["message"].getStr().contains("plain message")

  test "logDriverDebug adds default event only when missing":
    let sink = LogSink(entries: @[])
    setDriverDebugLogger(makeLogger(sink, debug = true))

    logDriverDebug(%*{"message": "hello"})
    logDriverDebug(%*{"event": "custom:event", "message": "world"})

    check sink.entries.len == 2
    check sink.entries[0]["event"].getStr() == "driver:waveshare:debug"
    check sink.entries[0]["message"].getStr() == "hello"
    check sink.entries[1]["event"].getStr() == "custom:event"
    check sink.entries[1]["message"].getStr() == "world"

  test "logDriverDebug is no-op when debug logger is disabled":
    let sink = LogSink(entries: @[])
    setDriverDebugLogger(makeLogger(sink, debug = false))

    logDriverDebug(%*{"message": "ignored"})
    check sink.entries.len == 0

import std/[json, options, strutils, unittest]

import ../inkyPython
import frameos/types

type LogSink = ref object
  entries: seq[JsonNode]

proc makeLogger(sink: LogSink): Logger =
  result = Logger(enabled: true)
  result.log = proc(payload: JsonNode) =
    sink.entries.add(copy(payload))
  result.enable = proc() = discard
  result.disable = proc() = discard

suite "inkyPython helper procs":
  test "deviceArgs includes device only when provided":
    check deviceArgs("") == newSeq[string]()
    check deviceArgs("pimoroni.inky_impression_7") == @["--device", "pimoroni.inky_impression_7"]

  test "safeLog parses json payloads and wraps plain messages":
    let sink = LogSink(entries: @[])
    let logger = makeLogger(sink)

    let parsed = logger.safeLog("""{"hello":"world"}""")
    check parsed["event"].getStr() == "driver:inky"
    check parsed["hello"].getStr() == "world"

    let wrapped = logger.safeLog("just text")
    check wrapped["event"].getStr() == "driver:inky"
    check wrapped["log"].getStr() == "just text"
    check sink.entries.len == 2

  test "safeStartProcess returns none and logs on start failure":
    let sink = LogSink(entries: @[])
    let logger = makeLogger(sink)
    let missingCommand = "/definitely/missing/frameos-inky-helper-binary"

    let processOpt = safeStartProcess(missingCommand, @[], ".", logger)
    check processOpt.isNone
    check sink.entries.len == 1
    check sink.entries[0]["event"].getStr() == "driver:inky"
    check sink.entries[0]["log"].getStr().contains("Error starting process")
    check sink.entries[0]["log"].getStr().contains(missingCommand)

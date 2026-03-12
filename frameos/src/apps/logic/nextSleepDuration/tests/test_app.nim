import std/[json, strutils, unittest]

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

suite "logic/nextSleepDuration app":
  test "sets nextSleep and emits a log message":
    let logs = LogStore(items: @[])
    let scene = FrameScene(logger: newLogger(logs))
    let app = App(
      nodeId: 7.NodeId,
      nodeName: "logic/nextSleepDuration",
      scene: scene,
      appConfig: AppConfig(duration: 12.5)
    )
    let context = ExecutionContext(nextSleep: -1)

    app.run(context)

    check context.nextSleep == 12.5
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("log:7:logic/nextSleepDuration")
    check logs.items[0]["message"].getStr().contains("12.5")

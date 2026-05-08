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

suite "data/log app":
  test "null payload is returned without emitting logs":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 5.NodeId,
      nodeName: "data/log",
      scene: FrameScene(logger: newLogger(logs)),
      appConfig: AppConfig(inputJson: newJNull())
    )

    let output = app.get(ExecutionContext())
    check output.kind == JNull
    check logs.items.len == 0

  test "string and object payloads pass through and emit shaped log events":
    let logs = LogStore(items: @[])
    let scene = FrameScene(logger: newLogger(logs))

    let strApp = App(
      nodeId: 6.NodeId,
      nodeName: "data/log",
      scene: scene,
      appConfig: AppConfig(inputJson: %*"hello")
    )
    let strOut = strApp.get(ExecutionContext())
    check strOut.getStr() == "hello"
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("log:6:data/log:log")
    check logs.items[0]["message"].getStr() == "hello"

    let objApp = App(
      nodeId: 7.NodeId,
      nodeName: "data/log",
      scene: scene,
      appConfig: AppConfig(inputJson: %*{"x": 1})
    )
    let objOut = objApp.get(ExecutionContext())
    check objOut["x"].getInt() == 1
    check logs.items.len == 2
    check logs.items[1]["event"].getStr().contains("log:7:data/log:log")
    check logs.items[1]["message"]["x"].getInt() == 1

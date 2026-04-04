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

proc newScene(store: LogStore): FrameScene =
  FrameScene(
    state: %*{},
    logger: newLogger(store)
  )

suite "logic/log app":
  test "missing inputs do not emit logs":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 21.NodeId,
      nodeName: "logic/log",
      scene: newScene(logs),
      appConfig: AppConfig()
    )

    app.run(ExecutionContext())
    check logs.items.len == 0

  test "string and object payloads emit shaped log events":
    let logs = LogStore(items: @[])
    let scene = newScene(logs)

    let strApp = App(
      nodeId: 22.NodeId,
      nodeName: "logic/log",
      scene: scene,
      appConfig: AppConfig(inputString: "hello")
    )
    strApp.run(ExecutionContext())
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("log:22:logic/log:log")
    check logs.items[0]["message"].getStr() == "hello"

    let objApp = App(
      nodeId: 23.NodeId,
      nodeName: "logic/log",
      scene: scene,
      appConfig: AppConfig(inputJson: %*{"x": 1})
    )
    objApp.run(ExecutionContext())
    check logs.items.len == 2
    check logs.items[1]["event"].getStr().contains("log:23:logic/log:log")
    check logs.items[1]["message"]["x"].getInt() == 1

  test "when both inputs are set the app logs an error and exits":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 24.NodeId,
      nodeName: "logic/log",
      scene: newScene(logs),
      appConfig: AppConfig(inputString: "hello", inputJson: %*{"x": 1})
    )

    app.run(ExecutionContext())

    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:24:logic/log")
    check logs.items[0]["error"].getStr() == "Both inputString and inputJson are set. Only one can be set."

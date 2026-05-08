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

suite "logic/setAsState app":
  test "valueJson writes state":
    let logs = LogStore(items: @[])
    let scene = newScene(logs)
    let app = App(
      scene: scene,
      appConfig: AppConfig(valueJson: %*{"x": 1}, stateKey: "payload", debugLog: false)
    )

    app.run(ExecutionContext())
    check scene.state["payload"]["x"].getInt() == 1

  test "valueString writes state":
    let logs = LogStore(items: @[])
    let scene = newScene(logs)
    let app = App(
      scene: scene,
      appConfig: AppConfig(valueString: "ready", stateKey: "status", debugLog: false)
    )

    app.run(ExecutionContext())
    check scene.state["status"].getStr() == "ready"

  test "when both values are set app logs an error and exits":
    let logs = LogStore(items: @[])
    let scene = newScene(logs)
    let app = App(
      nodeId: 12.NodeId,
      nodeName: "logic/setAsState",
      scene: scene,
      appConfig: AppConfig(
        valueString: "a",
        valueJson: %*{"x": 1},
        stateKey: "mixed",
        debugLog: false,
      )
    )

    app.run(ExecutionContext())

    check not scene.state.hasKey("mixed")
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:12:logic/setAsState")

  test "debug log includes written state value":
    let logs = LogStore(items: @[])
    let scene = newScene(logs)
    let app = App(
      nodeId: 13.NodeId,
      nodeName: "logic/setAsState",
      scene: scene,
      appConfig: AppConfig(valueString: "frame", stateKey: "name", debugLog: true)
    )

    app.run(ExecutionContext())

    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("setAsState")
    check logs.items[0]["key"].getStr() == "name"
    check logs.items[0]["value"].getStr() == "frame"

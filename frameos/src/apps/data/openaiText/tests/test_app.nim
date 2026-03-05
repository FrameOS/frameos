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

suite "data/openaiText app":
  test "missing system and user prompt writes error state":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 8.NodeId,
      nodeName: "data/openaiText",
      scene: scene,
      appConfig: AppConfig(system: "", user: "", stateKey: "reply")
    )

    let output = app.get(ExecutionContext())

    check output == ""
    check scene.state["reply"].getStr() == "Error: No system or user prompt provided in app config."
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:8:data/openaiText")

  test "missing api key writes settings error state":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 9.NodeId,
      nodeName: "data/openaiText",
      scene: scene,
      frameConfig: FrameConfig(settings: %*{}),
      appConfig: AppConfig(system: "system", user: "hello", stateKey: "reply")
    )

    let output = app.get(ExecutionContext())

    check output == ""
    check scene.state["reply"].getStr() == "Error: Please provide an OpenAI API key in the settings."
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:9:data/openaiText")

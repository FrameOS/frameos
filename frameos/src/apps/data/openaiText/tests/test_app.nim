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
  test "missing system and user prompt logs an error and leaves state alone":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 8.NodeId,
      nodeName: "data/openaiText",
      scene: scene,
      appConfig: AppConfig(system: "", user: "")
    )

    let output = app.get(ExecutionContext())

    check output == ""
    check scene.state.len == 0
    check logs.items[0]["error"].getStr() == "No system or user prompt provided in app config."
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:8:data/openaiText")

  test "missing api key logs a settings error and leaves state alone":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 9.NodeId,
      nodeName: "data/openaiText",
      scene: scene,
      frameConfig: FrameConfig(settings: %*{}),
      appConfig: AppConfig(system: "system", user: "hello")
    )

    let output = app.get(ExecutionContext())

    check output == ""
    check scene.state.len == 0
    check logs.items[0]["error"].getStr() == "Please provide an OpenAI API key in the settings."
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:9:data/openaiText")

  test "request log records prompt sizes, never the prompts":
    let app = App(
      nodeId: 10.NodeId,
      nodeName: "data/openaiText",
      appConfig: AppConfig(model: "gpt-test", system: "You are private.", user: "My address is 1 Secret St.")
    )
    let payload = app.requestLogPayload()
    check payload["model"].getStr() == "gpt-test"
    check payload["systemPromptChars"].getInt() == 16
    check payload["userPromptChars"].getInt() == 26
    check "Secret" notin $payload
    check "private" notin $payload

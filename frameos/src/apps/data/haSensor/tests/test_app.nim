import std/[json, unittest]

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc makeApp(settings: JsonNode, debug = false): App =
  let logs = LogStore(items: @[])
  App(
    nodeId: 3.NodeId,
    nodeName: "data/haSensor",
    scene: FrameScene(logger: newLogger(logs)),
    frameConfig: FrameConfig(settings: settings),
    appConfig: AppConfig(entityId: "sensor.outdoor_temp", debug: debug)
  )

suite "data/haSensor app":
  test "missing Home Assistant URL returns deterministic error payload":
    let app = makeApp(%*{"homeAssistant": {"accessToken": "token"}}, debug = false)

    let output = app.get(ExecutionContext())
    check output == %*{"error": "Please provide a Home Assistant URL in the settings."}

  test "missing Home Assistant access token returns deterministic error payload":
    let app = makeApp(%*{"homeAssistant": {"url": "http://ha.local"}}, debug = true)

    let output = app.get(ExecutionContext())
    check output == %*{"error": "Please provide a Home Assistant access token in the settings."}

  test "error helper returns shaped payload":
    let app = makeApp(%*{"homeAssistant": {}})

    let output = app.error("boom")
    check output == %*{"error": "boom"}

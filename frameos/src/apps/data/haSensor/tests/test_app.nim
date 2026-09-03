import std/[json, options, strutils, times, unittest]

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

  test "entity ids must be <domain>.<object_id>":
    check isHaEntityId("sensor.outdoor_temp")
    check isHaEntityId("binary_sensor.door_2")
    check not isHaEntityId("")
    check not isHaEntityId("sensor")
    check not isHaEntityId("sensor.")
    check not isHaEntityId(".temp")
    check not isHaEntityId("sensor.a.b")
    check not isHaEntityId("Sensor.Temp")
    check not isHaEntityId("sensor.temp/../../admin")
    check not isHaEntityId("sensor.temp?x=1")
    check not isHaEntityId("sensor.temp#frag")

  test "a malformed entity id never reaches the network":
    let app = makeApp(%*{"homeAssistant": {"url": "http://127.0.0.1:9", "accessToken": "token"}})
    app.appConfig.entityId = "../../api/config"

    let output = app.get(ExecutionContext())
    check output.hasKey("error")
    check "Invalid Home Assistant entity id" in output["error"].getStr()

  test "error helper returns shaped payload":
    let app = makeApp(%*{"homeAssistant": {}})

    let output = app.error("boom")
    check output == %*{"error": "boom"}

  test "recent cached response avoids a new fetch":
    let app = makeApp(%*{"homeAssistant": {"url": "http://127.0.0.1:9", "accessToken": "token"}})
    app.json = some(%*{"state": "cached"})
    app.lastFetchAt = epochTime()

    let output = app.get(ExecutionContext())
    output["state"] = %"changed"

    check output["state"].getStr() == "changed"
    check app.json.get()["state"].getStr() == "cached"

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
  test "overrides this render's sleep and leaves the scene's interval alone":
    let logs = LogStore(items: @[])
    let scene = FrameScene(logger: newLogger(logs), state: %*{"refreshInterval": 3600.0},
      refreshInterval: 3600.0, refreshIntervalKey: "refreshInterval", refreshIntervalDefault: 3600.0)
    let app = App(
      nodeId: 7.NodeId,
      nodeName: "logic/nextSleepDuration",
      scene: scene,
      appConfig: AppConfig(duration: 12.5)
    )
    let context = ExecutionContext(scene: scene, nextSleep: -1)

    app.run(context)

    check context.nextSleep == 12.5
    # One-time: the interval the next render falls back to is untouched
    check scene.state["refreshInterval"].getFloat() == 3600.0
    check scene.refreshInterval == 3600.0
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("log:7:logic/nextSleepDuration")
    check logs.items[0]["message"].getStr().contains("12.5")

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

proc newApp(scene: FrameScene, duration: float): App =
  App(nodeId: 7.NodeId, nodeName: "logic/nextSleepDuration", scene: scene,
    appConfig: AppConfig(duration: duration))

suite "logic/nextSleepDuration app":
  test "sets the scene's refresh interval through its state field":
    let logs = LogStore(items: @[])
    let scene = FrameScene(logger: newLogger(logs), state: %*{"seconds": 600.0},
      refreshInterval: 600.0, refreshIntervalKey: "seconds", refreshIntervalDefault: 600.0)
    # The scene's own render: the scene IS the context's scene
    let context = ExecutionContext(scene: scene, nextSleep: -1)

    newApp(scene, 12.5).run(context)

    check scene.state["seconds"].getFloat() == 12.5
    check scene.refreshInterval == 12.5
    # One flow: the host loop reads the scene's interval, not a side channel
    check context.nextSleep == -1
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("log:7:logic/nextSleepDuration")
    check logs.items[0]["message"].getStr().contains("12.5")

  test "embedded in another scene, it still tells the host's render cycle":
    let logs = LogStore(items: @[])
    let host = FrameScene(logger: newLogger(logs), state: %*{}, refreshInterval: 300.0)
    let child = FrameScene(logger: newLogger(logs), state: %*{}, refreshIntervalKey: "refreshInterval")
    let context = ExecutionContext(scene: host, nextSleep: -1)

    newApp(child, 45).run(context)

    check child.state["refreshInterval"].getFloat() == 45.0
    check child.refreshInterval == 45.0
    check context.nextSleep == 45.0
    check host.refreshInterval == 300.0

  test "ignores a duration that is not a positive number":
    let logs = LogStore(items: @[])
    let scene = FrameScene(logger: newLogger(logs), state: %*{"refreshInterval": 300.0},
      refreshInterval: 300.0, refreshIntervalKey: "refreshInterval")
    let context = ExecutionContext(scene: scene, nextSleep: -1)

    newApp(scene, 0).run(context)

    check scene.state["refreshInterval"].getFloat() == 300.0
    check scene.refreshInterval == 300.0
    check context.nextSleep == -1
    check logs.items[0]["message"].getStr().contains("Ignored")

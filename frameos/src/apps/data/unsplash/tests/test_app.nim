import std/[json, strutils, unittest]
import pixie

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

suite "data/unsplash app":
  test "init trims search string":
    let app = App(appConfig: AppConfig(search: "  blue sky  "))

    app.init()

    check app.appConfig.search == "blue sky"

  test "missing api key returns error image with context dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 6.NodeId,
      nodeName: "data/unsplash",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6, settings: %*{}),
      appConfig: AppConfig(search: "cats", metadataStateKey: "meta")
    )

    let image = app.get(ExecutionContext(image: newImage(15, 9), hasImage: true))

    check image.width == 15
    check image.height == 9
    check not scene.state.hasKey("meta")
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:6:data/unsplash")

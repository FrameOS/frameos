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

suite "data/wikicommons app":
  test "init trims text fields":
    let app = App(appConfig: AppConfig(
      mode: "  pictureOfTheDay  ",
      submode: "  day  ",
      metadataStateKey: "  commons  "
    ))

    app.init()

    check app.appConfig.mode == "pictureOfTheDay"
    check app.appConfig.submode == "day"
    check app.appConfig.metadataStateKey == "commons"

  test "invalid mode returns error image with context dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 12.NodeId,
      nodeName: "data/wikicommons",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6),
      appConfig: AppConfig(mode: "not-a-mode", metadataStateKey: "meta")
    )

    let image = app.get(ExecutionContext(image: newImage(15, 9), hasImage: true))

    check image.width == 15
    check image.height == 9
    check not scene.state.hasKey("meta")
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:12:data/wikicommons")

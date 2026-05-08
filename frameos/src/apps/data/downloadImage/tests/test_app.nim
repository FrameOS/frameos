import std/[json, unittest]
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

proc makeFrameConfig(width = 8, height = 6, rotate = 0): FrameConfig =
  FrameConfig(width: width, height: height, rotate: rotate)

proc makeApp(scene: FrameScene, frameConfig: FrameConfig, metadataStateKey = "meta"): App =
  App(
    scene: scene,
    frameConfig: frameConfig,
    appConfig: AppConfig(url: "not-a-valid-url", metadataStateKey: metadataStateKey)
  )

suite "data/downloadImage app":
  test "invalid URL returns error image with context dimensions and does not write metadata":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = makeApp(scene, makeFrameConfig())
    let context = ExecutionContext(image: newImage(13, 9), hasImage: true)

    let outputImage = app.get(context)

    check outputImage.width == 13
    check outputImage.height == 9
    check not scene.state.hasKey("meta")

  test "invalid URL falls back to frame render dimensions without context image":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = makeApp(scene, makeFrameConfig(width = 7, height = 4, rotate = 90), metadataStateKey = "")

    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 4
    check outputImage.height == 7

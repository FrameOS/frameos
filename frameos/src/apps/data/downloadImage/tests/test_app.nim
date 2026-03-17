import std/[base64, json, strformat, unittest]
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

proc pngDataUrl(width = 2, height = 3): string =
  let image = newImage(width, height)
  let png = image.encodeImage(PngFormat)
  result = &"data:image/png;base64,{png.encode}"

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

  test "data URL without metadata keeps old success path":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      scene: scene,
      frameConfig: makeFrameConfig(),
      appConfig: AppConfig(url: pngDataUrl(), metadataStateKey: "")
    )

    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 2
    check outputImage.height == 3
    check scene.state.kind == JObject
    check scene.state.len == 0
    check logs.items.len == 0

  test "data URL with metadata stores dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let url = pngDataUrl()
    let app = App(
      scene: scene,
      frameConfig: makeFrameConfig(),
      appConfig: AppConfig(url: url, metadataStateKey: "meta")
    )

    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 2
    check outputImage.height == 3
    check scene.state["meta"]["url"].getStr() == url
    check scene.state["meta"]["width"].getInt() == 2
    check scene.state["meta"]["height"].getInt() == 3
    check logs.items.len == 0

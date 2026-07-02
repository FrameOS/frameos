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

const
  tokenA = "AP1GczN" & repeat("aB3", 20)
  tokenB = "AP1GczM" & repeat("xY7", 20)
  tokenC = "AF1QipP" & repeat("qW9", 20)
  tokenD = "AP1GczQ" & repeat("kL5", 20)
  baseA = photoUrlHost & "pw/" & tokenA
  baseB = photoUrlHost & "pw/" & tokenB
  baseC = photoUrlHost & tokenC
  baseD = photoUrlHost & "pw/" & tokenD

let albumHtml = ("""
<!DOCTYPE html><html><head><title>Holidays - Google Photos</title>
<meta property="og:image" content="{A}=w600-h315-p-k-no">
</head><body>
<img src="https://lh3.googleusercontent.com/a/ACg8ocJx5vN2mP8qR4sT0uW6yZ2aB8cD4eF0gH=s64-c" alt="avatar">
<script>AF_initDataCallback({key: 'ds:1', data:[
["{A}",1024,768],
["{B}=w417-h174-k-no",417,174],
["{C}",800,600],
["https://lh3.googleusercontent.com/pw/short=w32-h32",32,32],
"[[\"{D}\",417,174]]"
]});</script>
</body></html>
""")
  .replace("{A}", baseA)
  .replace("{B}", baseB)
  .replace("{C}", baseC)
  .replace("{D}", baseD)

suite "data/googlePhotos app":
  test "extractPhotoUrls finds, unescapes, dedupes and filters urls":
    let urls = extractPhotoUrls(albumHtml)

    check urls == @[baseA, baseB, baseC, baseD]

  test "extractPhotoUrls skips avatars and short paths":
    let html = """
<img src="https://lh3.googleusercontent.com/a/ACg8ocJx5vN2mP8qR4sT0uW6yZ2aB8cD4eF0gH=s64-c">
<img src="https://lh3.googleusercontent.com/pw/short=w32-h32">
"""
    check extractPhotoUrls(html).len == 0

  test "extractPhotoUrls returns empty for html without photos":
    check extractPhotoUrls("<html><body>Nothing here</body></html>").len == 0

  test "sizedPhotoUrl maps fit modes to url suffixes":
    check sizedPhotoUrl(baseA, 800, 480, "cover") == baseA & "=w800-h480-c"
    check sizedPhotoUrl(baseA, 800, 480, "contain") == baseA & "=w800-h480-no"

  test "wrapIndex wraps the sequential counter":
    check wrapIndex(0, 5) == 0
    check wrapIndex(4, 5) == 4
    check wrapIndex(5, 5) == 0
    check wrapIndex(7, 5) == 2
    check wrapIndex(-1, 5) == 4
    check wrapIndex(3, 0) == 0

  test "init trims fields, defaults cache duration and restores the counter":
    let scene = FrameScene(state: %*{"counter": 7}, logger: newLogger(LogStore(items: @[])))
    let app = App(
      scene: scene,
      appConfig: AppConfig(
        shareUrl: "  https://photos.app.goo.gl/AbCdEf  ",
        mode: "sequential",
        counterStateKey: "  counter  ",
        metadataStateKey: "  meta  ",
        cacheAlbumSeconds: 0
      )
    )

    app.init()

    check app.appConfig.shareUrl == "https://photos.app.goo.gl/AbCdEf"
    check app.appConfig.counterStateKey == "counter"
    check app.appConfig.metadataStateKey == "meta"
    check app.appConfig.cacheAlbumSeconds == 3600
    check app.counter == 7

  test "init keeps a configured cache duration and seeds random mode":
    let app = App(appConfig: AppConfig(shareUrl: "", mode: "random", cacheAlbumSeconds: 900))

    app.init()

    check app.appConfig.cacheAlbumSeconds == 900
    check app.counter == 0

  test "missing share url returns error image with context dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 4.NodeId,
      nodeName: "data/googlePhotos",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6, settings: %*{}),
      appConfig: AppConfig(shareUrl: "", mode: "random")
    )

    let image = app.get(ExecutionContext(image: newImage(15, 9), hasImage: true))

    check image.width == 15
    check image.height == 9
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:4:data/googlePhotos")

  test "invalid share url returns error image without fetching":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 5.NodeId,
      nodeName: "data/googlePhotos",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6, settings: %*{}),
      appConfig: AppConfig(shareUrl: "photos.app.goo.gl/AbCdEf", mode: "random")
    )

    let image = app.get(ExecutionContext(image: newImage(12, 8), hasImage: true))

    check image.width == 12
    check image.height == 8
    check logs.items.len == 1
    check logs.items[0]["error"].getStr().contains("Invalid shared album link")

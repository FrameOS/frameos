import std/[json, strutils, times, unittest]
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

const assetsFixture = """[
  {"id": "img-1", "type": "IMAGE", "originalFileName": "IMG_001.HEIC"},
  {"id": "vid-1", "type": "VIDEO", "originalFileName": "MOV_001.MP4"},
  {"id": "img-2", "type": "IMAGE", "originalFileName": "IMG_002.jpg"}
]"""

const memoriesFixture = """[
  {"id": "mem-1", "assets": [
    {"id": "img-1", "type": "IMAGE"},
    {"id": "vid-1", "type": "VIDEO"}
  ]},
  {"id": "mem-2", "assets": [
    {"id": "img-2", "type": "IMAGE"}
  ]},
  {"id": "mem-3", "assets": []}
]"""

suite "data/immich app":
  test "init normalizes and defaults fields":
    let app = App(appConfig: AppConfig(
      mode: "  ",
      albumId: " abc ",
      personId: " p1 ",
      metadataStateKey: " meta ",
      previewSize: ""
    ))

    app.init()

    check app.appConfig.mode == "random"
    check app.appConfig.albumId == "abc"
    check app.appConfig.personId == "p1"
    check app.appConfig.metadataStateKey == "meta"
    check app.appConfig.previewSize == "preview"

  test "init keeps fullsize and explicit mode":
    let app = App(appConfig: AppConfig(mode: "album", previewSize: "fullsize"))

    app.init()

    check app.appConfig.mode == "album"
    check app.appConfig.previewSize == "fullsize"

  test "normalizeServerUrl strips whitespace and trailing slashes":
    check normalizeServerUrl("https://immich.example.com") == "https://immich.example.com"
    check normalizeServerUrl("https://immich.example.com/") == "https://immich.example.com"
    check normalizeServerUrl(" https://immich.example.com// ") == "https://immich.example.com"
    check normalizeServerUrl("") == ""

  test "api url builders":
    check searchRandomUrl("https://x") == "https://x/api/search/random"
    check legacyRandomUrl("https://x") == "https://x/api/assets/random?count=20"
    check albumUrl("https://x", "album-1") == "https://x/api/albums/album-1"
    check memoriesUrl("https://x", "2026-07-02T00:00:00.000Z") ==
      "https://x/api/memories?for=2026-07-02T00%3A00%3A00.000Z"

  test "assetDownloadUrl picks thumbnail or original":
    check assetDownloadUrl("https://x", "a-1", "preview") == "https://x/api/assets/a-1/thumbnail?size=preview"
    check assetDownloadUrl("https://x", "a-1", "fullsize") == "https://x/api/assets/a-1/original"

  test "todayIso formats the frame-local date at UTC midnight":
    let iso = todayIso()
    check iso.len == 24
    check iso.endsWith("T00:00:00.000Z")
    check iso[4] == '-' and iso[7] == '-'
    check iso[0..9] == now().format("yyyy-MM-dd")

  test "randomSearchBody includes only requested filters":
    let body = randomSearchBody()
    check body["size"].getInt == 1
    check body["type"].getStr == "IMAGE"
    check body["withExif"].getBool
    check body["withPeople"].getBool
    check not body.hasKey("albumIds")
    check not body.hasKey("personIds")
    check not body.hasKey("isFavorite")

    let full = randomSearchBody(albumId = "a-1", personId = "p-1", isFavorite = true)
    check full["albumIds"] == %["a-1"]
    check full["personIds"] == %["p-1"]
    check full["isFavorite"].getBool

  test "imageAssets filters to IMAGE type":
    let assets = imageAssets(parseJson(assetsFixture))
    check assets.len == 2
    check assets[0]["id"].getStr == "img-1"
    check assets[1]["id"].getStr == "img-2"
    check imageAssets(nil).len == 0
    check imageAssets(parseJson("{}")).len == 0
    check imageAssets(parseJson("[]")).len == 0

  test "memoriesImageAssets collects images across memories":
    let assets = memoriesImageAssets(parseJson(memoriesFixture))
    check assets.len == 2
    check assets[0]["id"].getStr == "img-1"
    check assets[1]["id"].getStr == "img-2"
    check memoriesImageAssets(parseJson("[]")).len == 0

  test "pickRandomAsset returns nil for empty and a member otherwise":
    check pickRandomAsset(@[]).isNil
    let single = @[parseJson("""{"id": "only"}""")]
    check pickRandomAsset(single)["id"].getStr == "only"
    let assets = imageAssets(parseJson(assetsFixture))
    let picked = pickRandomAsset(assets)
    check picked["id"].getStr in ["img-1", "img-2"]

  test "assetMetadata stores id, filename, exif and people":
    let asset = parseJson("""{
      "id": "img-1",
      "type": "IMAGE",
      "originalFileName": "IMG_001.HEIC",
      "exifInfo": {
        "make": "Apple",
        "model": "iPhone 15",
        "fNumber": 1.8,
        "exposureTime": "1/120",
        "iso": 64,
        "focalLength": 6.86,
        "dateTimeOriginal": "2024-06-01T12:00:00.000Z",
        "lensModel": null
      },
      "people": [{"name": "Alice"}, {"name": ""}, {"name": "Bob"}]
    }""")

    let metadata = assetMetadata(asset)

    check metadata["source"].getStr == "immich"
    check metadata["id"].getStr == "img-1"
    check metadata["originalFileName"].getStr == "IMG_001.HEIC"
    check metadata["make"].getStr == "Apple"
    check metadata["model"].getStr == "iPhone 15"
    check metadata["fNumber"].getFloat == 1.8
    check metadata["exposureTime"].getStr == "1/120"
    check metadata["iso"].getInt == 64
    check metadata["focalLength"].getFloat == 6.86
    check metadata["dateTimeOriginal"].getStr == "2024-06-01T12:00:00.000Z"
    check not metadata.hasKey("lensModel")
    check metadata["people"] == %["Alice", "Bob"]

  test "assetMetadata skips missing exif and people":
    let metadata = assetMetadata(parseJson("""{"id": "img-2"}"""))
    check metadata["source"].getStr == "immich"
    check metadata["id"].getStr == "img-2"
    check not metadata.hasKey("make")
    check not metadata.hasKey("people")

  test "assetFileExtension and assetBaseName":
    let asset = parseJson("""{"id": "img-1", "originalFileName": "IMG_001.HEIC"}""")
    check assetFileExtension(asset, "preview") == ".jpg"
    check assetFileExtension(asset, "fullsize") == ".heic"
    check assetBaseName(asset) == "IMG_001"

    let bare = parseJson("""{"id": "img-2"}""")
    check assetFileExtension(bare, "fullsize") == ".jpg"
    check assetBaseName(bare) == "img-2"

  test "missing settings returns error image with context dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 7.NodeId,
      nodeName: "data/immich",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6, settings: %*{}),
      appConfig: AppConfig(mode: "random", metadataStateKey: "meta")
    )

    let image = app.get(ExecutionContext(image: newImage(15, 9), hasImage: true))

    check image.width == 15
    check image.height == 9
    check not scene.state.hasKey("meta")
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:7:data/immich")
    check logs.items[0]["error"].getStr().contains("server URL")

  test "missing api key returns error image":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 7.NodeId,
      nodeName: "data/immich",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6, settings: %*{"immich": {"url": "https://immich.example.com/"}}),
      appConfig: AppConfig(mode: "random")
    )

    let image = app.get(ExecutionContext(image: newImage(12, 8), hasImage: true))

    check image.width == 12
    check image.height == 8
    check logs.items.len == 1
    check logs.items[0]["error"].getStr().contains("API key")

  test "album mode without album id errors before any request":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 7.NodeId,
      nodeName: "data/immich",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 6,
        settings: %*{"immich": {"url": "https://immich.example.com", "apiKey": "key"}}),
      appConfig: AppConfig(mode: "album", albumId: "")
    )

    let image = app.get(ExecutionContext(image: newImage(10, 6), hasImage: true))

    check image.width == 10
    check image.height == 6
    check logs.items.len == 1
    check logs.items[0]["error"].getStr().contains("album ID")

import std/[json, unittest]
import pixie

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

var
  galleryHookUrl {.global.}: string
  galleryHookMaxBytes {.global.}: int

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc fakeGalleryDownload(url: string, maxBytes: int, target: Image): Image =
  galleryHookUrl = url
  galleryHookMaxBytes = maxBytes
  check target.isNil
  newImage(2, 3)

suite "data/frameOSGallery app":
  test "resolvedCategory chooses categoryOther when category is other":
    check AppConfig(category: "news", categoryOther: "unused").resolvedCategory() == "news"
    check AppConfig(category: "other", categoryOther: "featured").resolvedCategory() == "featured"

  test "get logs resolved category and downloads expected gallery URL":
    let logs = LogStore(items: @[])
    galleryHookUrl = ""
    galleryHookMaxBytes = 0
    let previousHook = galleryDownloadHook
    galleryDownloadHook = fakeGalleryDownload
    defer:
      galleryDownloadHook = previousHook

    let app = App(
      nodeId: 11.NodeId,
      nodeName: "data/frameOSGallery",
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(
        maxHttpResponseBytes: 1234
      ),
      appConfig: AppConfig(category: "other", categoryOther: "nature")
    )

    let image = app.get(ExecutionContext())

    check image.width == 2
    check image.height == 3
    check galleryHookUrl == "https://gallery.frameos.net/image?category=nature"
    check galleryHookMaxBytes == 1234
    check logs.items.len == 1
    check logs.items[0]["category"].getStr() == "nature"

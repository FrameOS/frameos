import std/[json, unittest]
import pixie

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

var
  galleryHookUrl {.global.}: string
  galleryHookMaxBytes {.global.}: int
  galleryHookTarget {.global.}: Image
  galleryHookFit {.global.}: ScaledDecodeFit

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc fakeGalleryDownload(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit): Image =
  galleryHookUrl = url
  galleryHookMaxBytes = maxBytes
  check target.isNil
  check fit == fitCover
  newImage(2, 3)

proc recordingGalleryDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit): Image =
  galleryHookUrl = url
  galleryHookTarget = target
  galleryHookFit = fit
  if target.isNil: newImage(2, 3) else: target

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

suite "data/frameOSGallery decode-into-canvas hint":
  # The decode target and its fit come from the interpreter's hint, which is
  # the only thing that knows what the consumer will do with the image. Taking
  # context.image and the FRAME's scalingMode instead is what made an
  # ESP32 render `placement: "contain"` as cover: the producer cropped to the
  # frame default before the consumer ever saw the image.
  setup:
    galleryHookUrl = ""
    galleryHookTarget = nil
    galleryHookFit = fitCover

  proc newApp(scalingMode: string): App =
    App(
      nodeId: 11.NodeId,
      nodeName: "data/frameOSGallery",
      scene: FrameScene(logger: newLogger(LogStore(items: @[]))),
      frameConfig: FrameConfig(maxHttpResponseBytes: 1234, scalingMode: scalingMode),
      appConfig: AppConfig(category: "nature")
    )

  test "uses the hint's placement, not the frame's scaling mode":
    let previousHook = galleryDownloadHook
    galleryDownloadHook = recordingGalleryDownload
    defer: galleryDownloadHook = previousHook

    let canvas = newImage(8, 4)
    let context = ExecutionContext(
      image: canvas, hasImage: true,
      decodeTargetImage: canvas, decodeTargetScalingMode: "contain"
    )
    # Frame says cover; the consuming node asked for contain. The node wins.
    discard newApp("cover").get(context)

    check galleryHookTarget == canvas
    check galleryHookFit == fitContain
    # The hint is for one decode: a sibling producer under the same context
    # must not inherit this canvas.
    check context.decodeTargetImage.isNil
    check context.decodeTargetScalingMode == ""

  test "without a hint it does not decode into the canvas":
    let previousHook = galleryDownloadHook
    galleryDownloadHook = recordingGalleryDownload
    defer: galleryDownloadHook = previousHook

    let canvas = newImage(8, 4)
    # A canvas is present, but the interpreter did not offer it — the consumer
    # will place the image itself, so cropping to it here would be wrong.
    let context = ExecutionContext(image: canvas, hasImage: true)
    let image = newApp("cover").get(context)

    check galleryHookTarget.isNil
    check image.width == 2
    check image.height == 3

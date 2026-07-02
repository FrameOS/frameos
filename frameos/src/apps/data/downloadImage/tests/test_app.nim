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

proc makeFrameConfig(width = 8, height = 6, rotate = 0): FrameConfig =
  FrameConfig(width: width, height: height, rotate: rotate)

proc makeApp(scene: FrameScene, frameConfig: FrameConfig, metadataStateKey = "meta"): App =
  App(
    scene: scene,
    frameConfig: frameConfig,
    appConfig: AppConfig(url: "not-a-valid-url", metadataStateKey: metadataStateKey)
  )

proc minimalExifJpeg(): string =
  # SOI + APP1 with a little-endian TIFF holding Make "Canon" (out of line,
  # data area at TIFF offset 0x26) and Model "EOS" (inline) + EOI.
  const tiff =
    "II\x2A\x00\x08\x00\x00\x00" &
    "\x02\x00" &
    "\x0F\x01\x02\x00\x06\x00\x00\x00\x26\x00\x00\x00" &
    "\x10\x01\x02\x00\x04\x00\x00\x00EOS\x00" &
    "\x00\x00\x00\x00" &
    "Canon\x00"
  let payload = "Exif\x00\x00" & tiff
  let segmentLen = payload.len + 2
  "\xFF\xD8\xFF\xE1" & chr((segmentLen shr 8) and 0xFF) & chr(segmentLen and 0xFF) &
    payload & "\xFF\xD9"

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
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error")
    check logs.items[0]["error"].getStr().contains("An error occurred while downloading the image:")

  test "invalid URL falls back to frame render dimensions without context image":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = makeApp(scene, makeFrameConfig(width = 7, height = 4, rotate = 90), metadataStateKey = "")

    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 4
    check outputImage.height == 7

  test "buildMetadata merges parsed exif from jpeg bytes":
    let metadata = buildMetadata("http://example.com/a.jpg", newImage(3, 2), minimalExifJpeg())

    check metadata["url"].getStr() == "http://example.com/a.jpg"
    check metadata["width"].getInt() == 3
    check metadata["height"].getInt() == 2
    check metadata["exif"]["make"].getStr() == "Canon"
    check metadata["exif"]["model"].getStr() == "EOS"
    check metadata["exifSummary"].getStr() == "Canon EOS"

  test "buildMetadata skips exif for non-jpeg data":
    let metadata = buildMetadata("http://example.com/a.png", newImage(1, 1), "not a jpeg")

    check metadata["width"].getInt() == 1
    check not metadata.hasKey("exifSummary")

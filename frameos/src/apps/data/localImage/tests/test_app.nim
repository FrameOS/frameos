import std/[json, os, strutils, times, unittest]
import pixie

import ../app
import frameos/types
import frameos/utils/exif

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc makeFrameConfig(assetsPath: string): FrameConfig =
  FrameConfig(width: 8, height: 6, rotate: 0, assetsPath: assetsPath)

proc writePpm(path: string, r, g, b: int) =
  writeFile(path, "P3\n1 1\n255\n" & $r & " " & $g & " " & $b & "\n")

proc uniqueTempDir(prefix: string): string =
  let ts = $(epochTime().int64)
  result = getTempDir() / (prefix & "-" & ts)
  createDir(result)

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

suite "data/localImage app":
  test "alphabetical mode sorts filenames before iterating":
    let root = uniqueTempDir("frameos-local-image-sorted")
    defer: removeDir(root)

    writePpm(root / "zeta.ppm", 255, 0, 0)
    writePpm(root / "Alpha.ppm", 0, 255, 0)
    writePpm(root / "middle.ppm", 0, 0, 255)

    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{"counter": 0}, logger: newLogger(logs))
    let app = App(
      scene: scene,
      frameConfig: makeFrameConfig(root),
      appConfig: AppConfig(
        path: root,
        order: "alphabetical",
        counterStateKey: "counter",
        metadataStateKey: "meta",
        search: "",
      )
    )

    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["filename"].getStr() == "Alpha.ppm"
    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["filename"].getStr() == "middle.ppm"
    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["filename"].getStr() == "zeta.ppm"

  test "discovery excludes internal dirs and non-images and metadata/counter are updated":
    let root = uniqueTempDir("frameos-local-image")
    defer: removeDir(root)

    createDir(root / "sub")
    createDir(root / ".thumbs")
    createDir(root / ".frameos" / "scene_images")
    writePpm(root / "first.PPM", 255, 0, 0)
    writePpm(root / "sub" / "second.ppm", 0, 255, 0)
    writePpm(root / ".thumbs" / "ignored.ppm", 0, 0, 255)
    writePpm(root / ".frameos" / "scene_images" / "ignored.ppm", 255, 255, 0)
    writeFile(root / "not-image.txt", "hello")

    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{"counter": 0}, logger: newLogger(logs))
    let app = App(
      scene: scene,
      frameConfig: makeFrameConfig(root),
      appConfig: AppConfig(
        path: root,
        order: "",
        counterStateKey: "counter",
        metadataStateKey: "meta",
        search: "",
      )
    )

    let image1 = app.get(ExecutionContext(hasImage: false))
    check image1.width == 1
    check image1.height == 1
    check scene.state["meta"]["total"].getInt() == 2
    check scene.state["meta"]["index"].getInt() == 0
    check scene.state["counter"].getInt() == 1
    check scene.state["meta"]["path"].getStr().toLowerAscii().contains(".ppm")

    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["total"].getInt() == 2
    check scene.state["counter"].getInt() == 0

  test "search filtering is case-insensitive and re-inits on search/path change":
    let rootA = uniqueTempDir("frameos-local-image-a")
    let rootB = uniqueTempDir("frameos-local-image-b")
    defer:
      removeDir(rootA)
      removeDir(rootB)

    writePpm(rootA / "SunSet.ppm", 10, 20, 30)
    writePpm(rootA / "Ocean.ppm", 30, 20, 10)
    writePpm(rootB / "Forest.ppm", 0, 255, 0)

    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      scene: scene,
      frameConfig: makeFrameConfig(rootA),
      appConfig: AppConfig(
        path: rootA,
        order: "",
        counterStateKey: "",
        metadataStateKey: "meta",
        search: "sunset",
      )
    )

    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["filename"].getStr() == "SunSet.ppm"

    app.appConfig.search = "ocean"
    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["filename"].getStr() == "Ocean.ppm"

    app.appConfig.path = rootB
    app.appConfig.search = "forest"
    discard app.get(ExecutionContext(hasImage: false))
    check scene.state["meta"]["filename"].getStr() == "Forest.ppm"

  test "readExifHead reads jpeg headers that merge into metadata":
    let root = uniqueTempDir("frameos-local-image-exif")
    defer: removeDir(root)

    let jpegPath = root / "photo.jpg"
    writeFile(jpegPath, minimalExifJpeg())

    let head = readExifHead(jpegPath)
    check head.len > 0

    var metadata = %*{"path": jpegPath}
    mergeParsedExif(metadata, head)
    check metadata["exif"]["make"].getStr() == "Canon"
    check metadata["exif"]["model"].getStr() == "EOS"
    check metadata["exifSummary"].getStr() == "Canon EOS"

  test "readExifHead skips non-jpeg files and caps reads at 256KB":
    let root = uniqueTempDir("frameos-local-image-exif-head")
    defer: removeDir(root)

    writePpm(root / "image.ppm", 1, 2, 3)
    check readExifHead(root / "image.ppm") == ""
    check readExifHead(root / "missing.jpg") == ""

    let bigPath = root / "big.JPEG"
    writeFile(bigPath, minimalExifJpeg() & repeat('\0', ExifScanBytes))
    check readExifHead(bigPath).len == ExifScanBytes

  test "empty-folder and no-match paths return deterministic error image dimensions":
    let root = uniqueTempDir("frameos-local-image-empty")
    defer: removeDir(root)

    writePpm(root / "sample.ppm", 1, 2, 3)

    let scene = FrameScene(state: %*{}, logger: newLogger(LogStore(items: @[])))
    let app = App(
      scene: scene,
      frameConfig: makeFrameConfig(root),
      appConfig: AppConfig(path: root, search: "not-found")
    )

    let noMatch = app.get(ExecutionContext(hasImage: false))
    check noMatch.width == 8
    check noMatch.height == 6

    app.appConfig.path = root / "missing"
    app.appConfig.search = ""
    let contextImage = newImage(7, 5)
    let emptyFolder = app.get(ExecutionContext(hasImage: true, image: contextImage))
    check emptyFolder.width == 7
    check emptyFolder.height == 5

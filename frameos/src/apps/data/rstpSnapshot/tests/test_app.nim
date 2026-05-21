import std/[json, strutils, unittest]
import pixie

import ../app
import frameos/types

type
  LogStore = ref object
    items: seq[JsonNode]

  HookMode = enum
    hmSuccess
    hmExitFailure
    hmTimeout
    hmDecodeFailure
    hmOSError

var
  hookMode {.global.}: HookMode
  capturedCommand {.global.}: string
  capturedTimeoutMs {.global.}: int

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc fakeFfmpegRunner(command: string, timeoutMs: int): tuple[data: string, exitCode: int] =
  capturedCommand = command
  capturedTimeoutMs = timeoutMs
  case hookMode
  of hmSuccess:
    var img = newImage(3, 2)
    img.fill(rgba(255, 0, 0, 255))
    result = (img.encodeImage(BmpFormat), 0)
  of hmExitFailure:
    result = ("", 7)
  of hmTimeout:
    result = ("", -1)
  of hmDecodeFailure:
    result = ("not-an-image", 0)
  of hmOSError:
    raise newException(OSError, "ffmpeg missing")

proc makeApp(scene: FrameScene, frameConfig: FrameConfig, url = "rtsp://cam/live", timeoutSeconds = 0): App =
  App(
    scene: scene,
    frameConfig: frameConfig,
    appConfig: AppConfig(url: url, timeoutSeconds: timeoutSeconds)
  )

suite "data/rstpSnapshot app":
  test "spawn OSError branch returns frame-sized error image":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmOSError
    capturedCommand = ""
    capturedTimeoutMs = 0
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let app = makeApp(FrameScene(logger: newLogger(LogStore(items: @[]))), FrameConfig(width: 8, height: 5, rotate: 90), timeoutSeconds = 4)
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 5
    check outputImage.height == 8
    check capturedCommand.contains("ffmpeg -loglevel quiet")
    check capturedTimeoutMs == 4000

  test "non-zero ffmpeg exit returns context-sized error image":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmExitFailure
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let app = makeApp(FrameScene(logger: newLogger(LogStore(items: @[]))), FrameConfig(width: 9, height: 6))
    let outputImage = app.get(ExecutionContext(hasImage: true, image: newImage(13, 7)))

    check outputImage.width == 13
    check outputImage.height == 7
    check capturedTimeoutMs == 15000

  test "ffmpeg timeout returns context-sized error image":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmTimeout
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let store = LogStore(items: @[])
    let app = makeApp(FrameScene(logger: newLogger(store)), FrameConfig(width: 9, height: 6), timeoutSeconds = 3)
    let outputImage = app.get(ExecutionContext(hasImage: true, image: newImage(13, 7)))

    check outputImage.width == 13
    check outputImage.height == 7
    check capturedTimeoutMs == 3000
    check ($store.items).contains("timeout after 3s")

  test "decode failure branch returns frame-sized error image":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmDecodeFailure
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let app = makeApp(FrameScene(logger: newLogger(LogStore(items: @[]))), FrameConfig(width: 11, height: 4))
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 11
    check outputImage.height == 4

  test "successful decode returns ffmpeg image bytes":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmSuccess
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let app = makeApp(FrameScene(logger: newLogger(LogStore(items: @[]))), FrameConfig(width: 20, height: 20))
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 3
    check outputImage.height == 2

  test "debug logging includes ffmpeg completion details":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmSuccess
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let store = LogStore(items: @[])
    let app = makeApp(FrameScene(logger: newLogger(store)), FrameConfig(width: 20, height: 20, debug: true))
    discard app.get(ExecutionContext(hasImage: false))

    let logs = $store.items
    check logs.contains("ffmpeg:start")
    check logs.contains("timeoutMs")
    check logs.contains("ffmpeg:done")
    check logs.contains("bytes")

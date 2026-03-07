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
    hmDecodeFailure
    hmOSError

var
  hookMode {.global.}: HookMode
  capturedCommand {.global.}: string

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc fakeFfmpegRunner(command: string): tuple[data: string, exitCode: int] =
  capturedCommand = command
  case hookMode
  of hmSuccess:
    var img = newImage(3, 2)
    img.fill(rgba(255, 0, 0, 255))
    result = (img.encodeImage(BmpFormat), 0)
  of hmExitFailure:
    result = ("", 7)
  of hmDecodeFailure:
    result = ("not-an-image", 0)
  of hmOSError:
    raise newException(OSError, "ffmpeg missing")

proc makeApp(scene: FrameScene, frameConfig: FrameConfig, url = "rtsp://cam/live"): App =
  App(
    scene: scene,
    frameConfig: frameConfig,
    appConfig: AppConfig(url: url)
  )

suite "data/rstpSnapshot app":
  test "spawn OSError branch returns frame-sized error image":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmOSError
    capturedCommand = ""
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let app = makeApp(FrameScene(logger: newLogger(LogStore(items: @[]))), FrameConfig(width: 8, height: 5, rotate: 90))
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 5
    check outputImage.height == 8
    check capturedCommand.contains("ffmpeg -loglevel quiet")

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

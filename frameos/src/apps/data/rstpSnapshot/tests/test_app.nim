import std/[json, strutils, unittest]
import pixie

import ../app
import frameos/types
import frameos/local_access

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
  test "the scene's timeout is clamped below the service watchdog":
    check ffmpegTimeoutMs(0) == 15000
    check ffmpegTimeoutMs(3) == 3000
    check ffmpegTimeoutMs(MaxFfmpegTimeoutSeconds) == MaxFfmpegTimeoutSeconds * 1000
    check ffmpegTimeoutMs(100_000) == MaxFfmpegTimeoutSeconds * 1000
    check MaxFfmpegTimeoutSeconds * 1000 < 900_000

  test "ffmpeg may only open the protocols the URL's scheme needs":
    let rtsp = ffmpegArgs("rtsp://cam/live", "pipe:1", scheme = "rtsp")
    let whitelistAt = rtsp.find("-protocol_whitelist")
    check whitelistAt >= 0
    check rtsp[whitelistAt + 1] == "rtsp,rtp,udp,tcp"
    check not rtsp[whitelistAt + 1].contains("file")
    check ffmpegProtocolWhitelist("https") == "https,http,tcp,tls"
    check ffmpegProtocolWhitelist("http") == "http,tcp"
    check ffmpegProtocolWhitelist("rtsps").contains("tls")
    # Without a scheme (the log preview) no whitelist is emitted.
    check ffmpegArgs("rtsp://cam/live", "pipe:1").find("-protocol_whitelist") == -1
    # A pinned http target keeps the scene's hostname as the Host header.
    let pinned = ffmpegArgs("http://10.0.0.9/snap.jpg", "pipe:1", scheme = "http", hostHeader = "cam.example")
    let headersAt = pinned.find("-headers")
    check headersAt >= 0
    check pinned[headersAt + 1] == "Host: cam.example\r\n"
    check pinned[pinned.find("-i") + 1] == "http://10.0.0.9/snap.jpg"

  test "a store-origin scene is refused before ffmpeg is spawned":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook
      forgetStoredLocalNetworkAccess()

    hookMode = hmSuccess
    capturedCommand = ""
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let store = LogStore(items: @[])
    let scene = InterpretedFrameScene(id: "store".SceneId, logger: newLogger(store), storeOrigin: true)
    let app = makeApp(scene, FrameConfig(width: 9, height: 6))
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 9
    check outputImage.height == 6
    check capturedCommand == ""

  test "a file:// target never reaches ffmpeg":
    let previousHook = rtspSnapshotFfmpegRunHook
    defer:
      rtspSnapshotFfmpegRunHook = previousHook

    hookMode = hmSuccess
    capturedCommand = ""
    rtspSnapshotFfmpegRunHook = fakeFfmpegRunner

    let app = makeApp(FrameScene(logger: newLogger(LogStore(items: @[]))), FrameConfig(width: 9, height: 6),
                      url = "file:///dev/video0")
    discard app.get(ExecutionContext(hasImage: false))
    check capturedCommand == ""

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

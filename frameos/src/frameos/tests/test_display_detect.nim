import std/[json, os, unittest, times]
import ../types
import ../display_detect

proc testLogger(events: ref seq[JsonNode]): Logger =
  var logger = Logger(enabled: true)
  logger.log = proc(payload: JsonNode) = events[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  logger

suite "display_detect":
  setup:
    resetDisplayDetectState()
    let dir = getTempDir() / ("frameos-display-detect-" & $epochTime())
    createDir(dir)
    let path = dir / "frame.json"
    var events = new seq[JsonNode]
    let logger = testLogger(events)
  teardown:
    removeDir(dir)

  test "writes the detected size into frame.json and logs it":
    writeFile(path, $(%*{"name": "x", "device": "framebuffer", "width": 800, "height": 480, "rotate": 0}))
    let config = FrameConfig(device: "framebuffer", width: 1920, height: 1080)
    check persistDetectedDisplaySize(config, logger, path)
    let data = parseFile(path)
    check data["width"].getInt == 1920
    check data["height"].getInt == 1080
    check data["name"].getStr == "x"
    check events[].len == 1
    check events[][0]["event"].getStr == "display:detected"
    check events[][0]["previousWidth"].getInt == 800

  test "no rewrite when the file already agrees, and the pre-check goes quiet":
    writeFile(path, $(%*{"width": 1920, "height": 1080}))
    let config = FrameConfig(device: "framebuffer", width: 1920, height: 1080)
    let before = getLastModificationTime(path)
    check detectedDisplayChanged(config)
    check not persistDetectedDisplaySize(config, logger, path)
    check not detectedDisplayChanged(config)
    check getLastModificationTime(path) == before
    check events[].len == 0

  test "a zero size is never persisted":
    writeFile(path, $(%*{"width": 800, "height": 480}))
    let config = FrameConfig(device: "framebuffer", width: 0, height: 0)
    check not detectedDisplayChanged(config)
    check not persistDetectedDisplaySize(config, logger, path)
    check parseFile(path)["width"].getInt == 800

  test "a later change is persisted again":
    writeFile(path, $(%*{"width": 800, "height": 480}))
    let config = FrameConfig(device: "framebuffer", width: 1920, height: 1080)
    check persistDetectedDisplaySize(config, logger, path)
    config.width = 3840
    config.height = 2160
    check persistDetectedDisplaySize(config, logger, path)
    check parseFile(path)["width"].getInt == 3840

  test "a missing file is not an error":
    let config = FrameConfig(device: "framebuffer", width: 1920, height: 1080)
    check not persistDetectedDisplaySize(config, logger, dir / "nope.json")
    check events[].len == 0

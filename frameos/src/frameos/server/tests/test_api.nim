import unittest
import times
import os
import mummy
import httpcore
import tables
import json
import zippy
import locks
import pixie

import ../api
import ../state
import ../../types
import ../../scenes
import ../../../drivers/plugin_runtime

proc baseConfig(assetsPath = ""): FrameConfig =
  FrameConfig(
    name: "Unit Frame",
    mode: "web_only",
    frameHost: "localhost",
    framePort: 8787,
    frameAccess: "private",
    frameAccessKey: "test-key",
    frameAdminAuth: %*{},
    serverHost: "localhost",
    serverPort: 8989,
    serverApiKey: "api",
    width: 800,
    height: 480,
    rotate: 0,
    flip: "",
    scalingMode: "contain",
    device: "web_only",
    metricsInterval: 60,
    assetsPath: assetsPath,
    saveAssets: %*(false),
    network: NetworkConfig(networkCheck: false),
  )

proc makeRequest(headers: seq[(string, string)] = @[]): Request =
  let request = create(RequestObj)
  request.httpMethod = "GET"
  request.queryParams = emptyQueryParams()
  for (key, value) in headers:
    request.headers[key] = value
  result = request

proc decodeResponseImage(body: string): Image =
  decodeImage(body)

proc sampleFallbackImage(): Image =
  result = newImage(2, 1)
  result.data[0] = rgbx(12, 34, 56, 255)
  result.data[1] = rgbx(90, 123, 210, 255)

suite "Server API helpers":
  teardown:
    clearCompiledDriversForTests()

  test "preview artifact decoder handles indexed2 row padding":
    let preview = DriverPreviewArtifact(
      width: 5,
      height: 2,
      rotate: 0,
      pixelFormat: dpfIndexed2,
      data: @[25'u8, 0'u8, 134'u8, 64'u8],
      palette: @[
        (0'u8, 0'u8, 0'u8),
        (255'u8, 0'u8, 0'u8),
        (255'u8, 255'u8, 255'u8),
      ],
    )

    let image = previewArtifactToImage(preview)
    check image != nil
    check image.width == 5
    check image.height == 2
    check image.data[0].r == 0
    check image.data[1].r == 255
    check image.data[1].g == 0
    check image.data[2].r == 255
    check image.data[2].g == 255
    check image.data[8].r == 255
    check image.data[8].g == 255
    check image.data[9].r == 255
    check image.data[9].g == 0

  test "preview artifact decoder handles indexed4 row padding":
    let preview = DriverPreviewArtifact(
      width: 3,
      height: 1,
      rotate: 0,
      pixelFormat: dpfIndexed4,
      data: @[0x05'u8, 0x60'u8],
      palette: @[
        (0'u8, 0'u8, 0'u8),
        (10'u8, 10'u8, 10'u8),
        (20'u8, 20'u8, 20'u8),
        (30'u8, 30'u8, 30'u8),
        (40'u8, 40'u8, 40'u8),
        (50'u8, 50'u8, 50'u8),
        (60'u8, 60'u8, 60'u8),
      ],
    )

    let image = previewArtifactToImage(preview)
    check image != nil
    check image.width == 3
    check image.data[0].r == 0
    check image.data[1].r == 50
    check image.data[2].r == 60

  test "frame image response falls back to the last rendered image":
    clearCompiledDriversForTests()
    globalFrameConfig = baseConfig()
    setLastImage(sampleFallbackImage())

    let response = buildFrameImageResponse(makeRequest())
    let image = decodeResponseImage(response.body)

    check int(response.status) == int(Http200)
    check response.headers["Content-Type"] == "image/png"
    check image != nil
    check image.width == 2
    check image.height == 1
    check image.data[0].r == 12
    check image.data[0].g == 34
    check image.data[0].b == 56
    check image.data[1].r == 90
    check image.data[1].g == 123
    check image.data[1].b == 210

  test "frame image response prefers a waveshare-style preview artifact":
    globalFrameConfig = baseConfig()
    setLastImage(sampleFallbackImage())
    setCompiledDriverPreviewForTests(DriverPreviewArtifact(
      width: 5,
      height: 2,
      rotate: 0,
      pixelFormat: dpfIndexed2,
      data: @[25'u8, 0'u8, 134'u8, 64'u8],
      palette: @[
        (0'u8, 0'u8, 0'u8),
        (255'u8, 0'u8, 0'u8),
        (255'u8, 255'u8, 255'u8),
      ],
    ))

    let response = buildFrameImageResponse(makeRequest())
    let image = decodeResponseImage(response.body)

    check int(response.status) == int(Http200)
    check image != nil
    check image.width == 5
    check image.height == 2
    check image.data[0].r == 0
    check image.data[1].r == 255
    check image.data[1].g == 0
    check image.data[2].r == 255
    check image.data[2].g == 255
    check image.data[8].r == 255
    check image.data[8].g == 255
    check image.data[9].r == 255
    check image.data[9].g == 0

  test "frame image response prefers an inky-style preview artifact":
    globalFrameConfig = baseConfig()
    setLastImage(sampleFallbackImage())
    setCompiledDriverPreviewForTests(DriverPreviewArtifact(
      width: 3,
      height: 1,
      rotate: 0,
      pixelFormat: dpfIndexed4,
      data: @[0x05'u8, 0x60'u8],
      palette: @[
        (0'u8, 0'u8, 0'u8),
        (10'u8, 10'u8, 10'u8),
        (20'u8, 20'u8, 20'u8),
        (30'u8, 30'u8, 30'u8),
        (40'u8, 40'u8, 40'u8),
        (50'u8, 50'u8, 50'u8),
        (60'u8, 60'u8, 60'u8),
      ],
    ))

    let response = buildFrameImageResponse(makeRequest())
    let image = decodeResponseImage(response.body)

    check int(response.status) == int(Http200)
    check image != nil
    check image.width == 3
    check image.height == 1
    check image.data[0].r == 0
    check image.data[1].r == 50
    check image.data[2].r == 60

  test "url encoded parser decodes values":
    let parsed = parseUrlEncoded("name=Frame%20One&flag=true&empty=")
    check parsed["name"] == "Frame One"
    check parsed["flag"] == "true"
    check parsed["empty"] == ""

  test "if-modified-since handling for mummy headers":
    let referenceTime = parse("Wed, 21 Oct 2015 07:28:00 GMT", "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    let referenceUnix = referenceTime.toTime().toUnix().float
    var headers: mummy.HttpHeaders
    headers["If-Modified-Since"] = "Wed, 21 Oct 2015 07:28:00 GMT"
    check shouldReturnNotModified(headers, referenceUnix)

  test "frameApiPayload reflects config active connections and scene payload fallback":
    let tempRoot = getTempDir() / "frameos-api-frame-payload"
    createDir(tempRoot)
    let configPath = tempRoot / "frame.json"
    writeFile(configPath, """{
      "interval": 42,
      "backgroundColor": "#123456",
      "color": "#ffffff"
    }""")
    putEnv("FRAMEOS_CONFIG", configPath)

    let scenesGzPath = tempRoot / "scenes.json.gz"
    writeFile(scenesGzPath, compress("""[{"id":"scene/a"}]""", dataFormat = dfGzip))
    putEnv("FRAMEOS_SCENES_JSON", scenesGzPath)

    globalFrameConfig = baseConfig(tempRoot)
    let state = initConnectionsState()
    withLock state.lock:
      state.items.add(default(WebSocket))
      state.items.add(default(WebSocket))

    let payload = frameApiPayload(state)
    check payload{"interval"}.getFloat() == 42
    check payload{"background_color"}.getStr() == "#123456"
    check payload{"active_connections"}.getInt() == 2
    check payload{"scenes"}.kind == JArray
    check payload{"scenes"}.len == 1
    check payload{"frame_access_key"}.getStr() == ""
    check payload{"server_api_key"}.getStr() == ""
    check payload{"frame_admin_auth"}{"enabled"}.getBool() == false

    let privilegedPayload = frameApiPayload(state, exposeSecrets = true)
    check privilegedPayload{"frame_access_key"}.getStr() == globalFrameConfig.frameAccessKey
    check privilegedPayload{"server_api_key"}.getStr() == globalFrameConfig.serverApiKey

    putEnv("FRAMEOS_SCENES_JSON", tempRoot / "invalid-scenes.json")
    writeFile(tempRoot / "invalid-scenes.json", "{not-json")
    let invalidScenesPayload = frameApiPayload(state)
    check invalidScenesPayload{"scenes"}.kind == JArray
    check invalidScenesPayload{"scenes"}.len == 0

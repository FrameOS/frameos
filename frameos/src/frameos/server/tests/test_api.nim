import unittest
import times
import os
import mummy
import tables
import json
import zippy
import locks

import ../api
import ../state
import ../../types

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

suite "Server API helpers":
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

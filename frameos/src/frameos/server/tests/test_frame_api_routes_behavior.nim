import std/[json, os, strutils, unittest]

import ./helpers/http_harness

var server = startRouterServer(19333)

suite "frame api route behavior":
  test "core frame api endpoints return expected shape":
    let config = defaultFrameConfig()
    configureServerState(config)

    let apps = httpRequest(server.port, "GET", "/api/apps?k=test-key")
    check apps.status == 200
    discard parseJson(apps.body)

    let frames = httpRequest(server.port, "GET", "/api/frames?k=test-key")
    check frames.status == 200
    let framesPayload = parseJson(frames.body)
    check framesPayload["frames"].kind == JArray
    check framesPayload["frames"].len == 1

    let frame = httpRequest(server.port, "GET", "/api/frames/1?k=test-key")
    check frame.status == 200
    let framePayload = parseJson(frame.body)
    check framePayload["frame"]["id"].getInt() == 1

    let ping = httpRequest(server.port, "GET", "/api/frames/1/ping?k=test-key")
    check ping.status == 200
    check parseJson(ping.body)["ok"].getBool()

    let state = httpRequest(server.port, "GET", "/api/frames/1/state?k=test-key")
    check state.status == 200
    let states = httpRequest(server.port, "GET", "/api/frames/1/states?k=test-key")
    check states.status == 200

  test "scoped endpoints return 404 for mismatched frame id":
    let config = defaultFrameConfig()
    configureServerState(config)

    for path in [
      "/api/frames/2",
      "/api/frames/2/ping",
      "/api/frames/2/state",
      "/api/frames/2/states",
      "/api/frames/2/assets",
      "/api/frames/2/asset?path=x&k=test-key",
      "/api/frames/2/image_token",
      "/api/frames/2/image",
    ]:
      let requestPath = if '?' in path: path else: path & "?k=test-key"
      let response = httpRequest(server.port, "GET", requestPath)
      check response.status == 404

  test "image token uses frame access key fallback":
    var config = defaultFrameConfig()
    configureServerState(config)

    let withKey = httpRequest(server.port, "GET", "/api/frames/1/image_token?k=test-key")
    check withKey.status == 200
    check parseJson(withKey.body)["token"].getStr() == "test-key"

    config.frameAccessKey = ""
    config.frameAccess = "public"
    configureServerState(config)
    let fallback = httpRequest(server.port, "GET", "/api/frames/1/image_token")
    check fallback.status == 200
    check parseJson(fallback.body)["token"].getStr() == "frame"

  test "asset endpoint surfaces helper status content-type and body":
    var config = defaultFrameConfig()
    let assetsRoot = getTempDir() / "frameos-frame-api-assets"
    createDir(assetsRoot)
    writeFile(assetsRoot / "hello.txt", "hello asset")
    config.assetsPath = assetsRoot
    configureServerState(config)

    let invalidPath = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=../secrets.txt&k=test-key",
    )
    check invalidPath.status == 400
    check invalidPath.body.contains("Invalid path")

    let missing = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=missing.txt&k=test-key",
    )
    check missing.status == 404
    check missing.body.contains("Asset not found")

    let found = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=hello.txt&k=test-key",
    )
    check found.status == 200
    check found.header("content-type") == "application/octet-stream"
    check found.body == "hello asset"

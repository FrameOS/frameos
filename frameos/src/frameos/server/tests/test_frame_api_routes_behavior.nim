import std/[json, os, strutils, unittest]
import zippy

import ../../channels
import ../state
import ./helpers/http_harness

var server = startRouterServer(19333)

proc adminCookieFrom(response: TestResponse): string =
  let cookie = response.header("set-cookie")
  if cookie.len == 0:
    return ""
  cookie.split(";", 1)[0]

suite "frame api route behavior":
  test "core frame api endpoints return expected shape":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let unauthorized = httpRequest(server.port, "GET", "/api/apps?k=test-key")
    check unauthorized.status == 401

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let apps = httpRequest(server.port, "GET", "/api/apps?k=test-key", headers = [("Cookie", adminCookie)])
    check apps.status == 200
    discard parseJson(apps.body)

    let fonts = httpRequest(server.port, "GET", "/api/fonts?k=test-key", headers = [("Cookie", adminCookie)])
    check fonts.status == 200
    check parseJson(fonts.body)["fonts"].kind == JArray

    let frames = httpRequest(server.port, "GET", "/api/frames?k=test-key", headers = [("Cookie", adminCookie)])
    check frames.status == 200
    let framesPayload = parseJson(frames.body)
    check framesPayload["frames"].kind == JArray
    check framesPayload["frames"].len == 1

    let frame = httpRequest(server.port, "GET", "/api/frames/1?k=test-key", headers = [("Cookie", adminCookie)])
    check frame.status == 200
    let framePayload = parseJson(frame.body)
    check framePayload["frame"]["id"].getInt() == 1

    let ping = httpRequest(server.port, "GET", "/api/frames/1/ping?k=test-key", headers = [("Cookie", adminCookie)])
    check ping.status == 200
    check parseJson(ping.body)["ok"].getBool()

    let state = httpRequest(server.port, "GET", "/api/frames/1/state?k=test-key", headers = [("Cookie", adminCookie)])
    check state.status == 200
    let states = httpRequest(server.port, "GET", "/api/frames/1/states?k=test-key", headers = [("Cookie", adminCookie)])
    check states.status == 200

  test "frame update endpoint persists config and interpreted scenes":
    drainEventChannel()
    let tempRoot = getTempDir() / "frameos-frame-api-save"
    createDir(tempRoot)
    let configPath = tempRoot / "frame.json"
    let scenesPath = tempRoot / "scenes.json.gz"
    writeFile(configPath, "{}")
    writeFile(scenesPath, compress("[]", dataFormat = dfGzip))

    let hadConfigEnv = existsEnv("FRAMEOS_CONFIG")
    let oldConfigEnv = if hadConfigEnv: getEnv("FRAMEOS_CONFIG") else: ""
    let hadScenesEnv = existsEnv("FRAMEOS_SCENES_JSON")
    let oldScenesEnv = if hadScenesEnv: getEnv("FRAMEOS_SCENES_JSON") else: ""
    try:
      putEnv("FRAMEOS_CONFIG", configPath)
      putEnv("FRAMEOS_SCENES_JSON", scenesPath)

      var config = defaultFrameConfig()
      config.frameAdminAuth = %*{
        "enabled": true,
        "user": "admin",
        "pass": "secret",
      }
      configureServerState(config)

      let login = httpRequest(
        server.port,
        "POST",
        "/api/admin/login",
        headers = [("Content-Type", "application/json")],
        body = $(%*{"username": "admin", "password": "secret"}),
      )
      let adminCookie = adminCookieFrom(login)

      let updatePayload = %*{
        "name": "Standalone editor",
        "interval": 42,
        "frame_admin_auth": {
          "enabled": true,
          "user": "admin",
          "pass": "new-secret",
        },
        "https_proxy": {
          "enable": true,
          "port": 9443,
          "expose_only_port": true,
          "certs": {"server": "cert", "server_key": "key"},
        },
        "error_behavior": {
          "mode": "silent_retry",
          "retry_seconds": 30,
          "silent_retry_seconds": 15,
          "silent_retry_forever": true,
          "silent_window_minutes": 7,
          "show_error_retry_seconds": 20,
        },
        "buildroot": {"readonly": true},
        "scenes": [
          {
            "id": "scene/local",
            "name": "Local scene",
            "nodes": [],
            "edges": [],
            "fields": [],
            "settings": {"execution": "interpreted", "backgroundColor": "#000000", "refreshInterval": 42},
          }
        ],
      }
      let update = httpRequest(
        server.port,
        "POST",
        "/api/frames/1",
        headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
        body = $updatePayload,
      )
      check update.status == 200

      let savedConfig = parseFile(configPath)
      check savedConfig["name"].getStr() == "Standalone editor"
      check savedConfig["interval"].getInt() == 42
      check savedConfig["frameAdminAuth"]["pass"].getStr() == "new-secret"
      check savedConfig["httpsProxy"]["port"].getInt() == 9443
      check savedConfig["httpsProxy"]["serverCert"].getStr() == "cert"
      check savedConfig["errorBehavior"]["silentRetryForever"].getBool()
      check savedConfig["frameApi"]["name"].getStr() == "Standalone editor"

      let savedScenes = parseJson(uncompress(readFile(scenesPath)))
      check savedScenes.kind == JArray
      check savedScenes.len == 1
      check savedScenes[0]["id"].getStr() == "scene/local"

      let (reloadReceived, reloadPayload) = eventChannel.tryRecv()
      check reloadReceived
      check reloadPayload[1] == "reload"

      let refreshedCookie = adminCookieFrom(update)
      check refreshedCookie.contains("frame_admin_session=")
      let frame = httpRequest(server.port, "GET", "/api/frames/1", headers = [("Cookie", refreshedCookie)])
      check frame.status == 200
      let framePayload = parseJson(frame.body)["frame"]
      check framePayload["name"].getStr() == "Standalone editor"
      check framePayload["frame_admin_auth"]["pass"].getStr() == "new-secret"
      check framePayload["https_proxy"]["port"].getInt() == 9443
      check framePayload["https_proxy"]["certs"]["server"].getStr() == "cert"
      check framePayload["https_proxy"]["certs"]["server_key"].getStr() == "key"
      check framePayload["error_behavior"]["mode"].getStr() == "silent_retry"
      check framePayload["error_behavior"]["silent_retry_forever"].getBool()
      check framePayload["buildroot"]["readonly"].getBool()
      check framePayload["scenes"].len == 1

      drainEventChannel()
      let reload = httpRequest(server.port, "POST", "/api/frames/1/reload", headers = [("Cookie", refreshedCookie)])
      check reload.status == 200
      check parseJson(reload.body)["action"].getStr() == "reload"
      let (runtimeReloadReceived, runtimeReloadPayload) = eventChannel.tryRecv()
      check runtimeReloadReceived
      check runtimeReloadPayload[1] == "reload"

      drainEventChannel()
      let restart = httpRequest(server.port, "POST", "/api/frames/1/restart", headers = [("Cookie", refreshedCookie)])
      check restart.status == 200
      check parseJson(restart.body)["action"].getStr() == "restart"
      let (restartReceived, restartPayload) = eventChannel.tryRecv()
      check restartReceived
      check restartPayload[1] == "restart"
    finally:
      if hadConfigEnv:
        putEnv("FRAMEOS_CONFIG", oldConfigEnv)
      else:
        delEnv("FRAMEOS_CONFIG")
      if hadScenesEnv:
        putEnv("FRAMEOS_SCENES_JSON", oldScenesEnv)
      else:
        delEnv("FRAMEOS_SCENES_JSON")

  test "legacy auth-disabled admin configs still require login":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "authEnabled": false,
    }
    configureServerState(config)

    let apps = httpRequest(server.port, "GET", "/api/apps")
    check apps.status == 401

    let frame = httpRequest(server.port, "GET", "/api/frames/1")
    check frame.status == 401

    let state = httpRequest(server.port, "GET", "/api/frames/1/state")
    check state.status == 401

  test "scoped endpoints return 404 for mismatched frame id":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    for path in [
      "/api/frames/2",
      "/api/frames/2/ping",
      "/api/frames/2/state",
      "/api/frames/2/states",
      "/api/frames/2/assets",
      "/api/frames/2/asset?path=x&k=test-key",
      "/api/frames/2/image",
      "/api/frames/2/scene_images/example-scene",
    ]:
      let requestPath = if '?' in path: path else: path & "?k=test-key"
      let response = httpRequest(server.port, "GET", requestPath, headers = [("Cookie", adminCookie)])
      check response.status == 404

    for path in [
      "/api/frames/2/reload",
      "/api/frames/2/restart",
    ]:
      let response = httpRequest(server.port, "POST", path, headers = [("Cookie", adminCookie)])
      check response.status == 404

  test "read access omits secrets while authenticated admins keep them":
    var config = defaultFrameConfig()
    config.frameAccess = "protected"
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let readOnly = httpRequest(server.port, "GET", "/api/frames")
    check readOnly.status == 401

    config.frameAccess = "private"
    configureServerState(config)
    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let privileged = httpRequest(
      server.port,
      "GET",
      "/api/frames/1",
      headers = [("Cookie", adminCookie)],
    )
    check privileged.status == 200
    let privilegedPayload = parseJson(privileged.body)["frame"]
    check privilegedPayload["frame_access_key"].getStr() == "test-key"
    check privilegedPayload["server_api_key"].getStr() == "api"
    check privilegedPayload["frame_admin_auth"]["user"].getStr() == "admin"

    let privilegedToken = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/ping",
      headers = [("Cookie", adminCookie)],
    )
    check privilegedToken.status == 200
    check parseJson(privilegedToken.body)["message"].getStr() == "pong"

  test "asset endpoint surfaces helper status content-type and body":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    let assetsRoot = getTempDir() / "frameos-frame-api-assets"
    createDir(assetsRoot)
    writeFile(assetsRoot / "hello.txt", "hello asset")
    config.assetsPath = assetsRoot
    configureServerState(config)

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let invalidPath = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=../secrets.txt&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check invalidPath.status == 400
    check invalidPath.body.contains("Invalid path")

    let missing = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=missing.txt&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check missing.status == 404
    check missing.body.contains("Asset not found")

    let found = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=hello.txt&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check found.status == 200
    check found.header("content-type") == "application/octet-stream"
    check found.body == "hello asset"

  test "scene image endpoint stores local scene previews":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    let assetsRoot = getTempDir() / "frameos-frame-api-scene-images"
    if dirExists(assetsRoot):
      removeDir(assetsRoot)
    createDir(assetsRoot)
    config.assetsPath = assetsRoot
    configureServerState(config)

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let missing = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/scene_images/example-scene?k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check missing.status == 404
    check missing.body.contains("Scene image not found")

    let saved = httpRequest(
      server.port,
      "POST",
      "/api/frames/1/scene_images/example-scene?k=test-key",
      headers = [("Cookie", adminCookie), ("Content-Type", "image/png")],
      body = "scene-image-bytes",
    )
    check saved.status == 201
    check parseJson(saved.body)["size"].getInt() == "scene-image-bytes".len

    let found = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/scene_images/example-scene?thumb=1&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check found.status == 200
    check found.header("content-type") == "image/png"
    check found.body == "scene-image-bytes"

  test "authenticated admins can still access frame asset endpoints":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    let assetsRoot = getTempDir() / "frameos-frame-api-assets-disabled"
    createDir(assetsRoot)
    writeFile(assetsRoot / "hello.txt", "hello asset")
    config.assetsPath = assetsRoot
    configureServerState(config)

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let listAssets = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/assets?k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check listAssets.status == 200

    let getAsset = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=hello.txt&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check getAsset.status == 200

  test "metrics endpoint returns stored metrics logs only":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    storeUiLog(%*{
      "id": 1,
      "timestamp": "2026-03-08T10:00:00Z",
      "ip": "",
      "type": "webhook",
      "event": "metrics",
      "line": $(%*{"event": "metrics", "cpuUsage": 42.5, "openFileDescriptors": 17}),
      "frame_id": 1,
    })
    storeUiLog(%*{
      "id": 2,
      "timestamp": "2026-03-08T10:00:05Z",
      "ip": "",
      "type": "webhook",
      "event": "http",
      "line": $(%*{"event": "http", "path": "/ping"}),
      "frame_id": 1,
    })
    storeUiLog(%*{
      "id": 3,
      "timestamp": "2026-03-08T10:00:10Z",
      "ip": "",
      "type": "webhook",
      "event": "metrics",
      "line": $(%*{"event": "metrics", "cpuUsage": 50.0}),
      "frame_id": 1,
    })
    storeUiLog(%*{
      "id": 4,
      "timestamp": "2026-03-08T10:00:20Z",
      "ip": "",
      "type": "webhook",
      "event": "metrics",
      "line": $(%*{"event": "metrics", "cpuUsage": 60.0}),
      "frame_id": 1,
    })

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let response = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/metrics?k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check response.status == 200

    let payload = parseJson(response.body)["metrics"]
    check payload.kind == JArray
    check payload.len == 3
    check payload[0]["id"].getStr() == "1"
    check payload[0]["timestamp"].getStr() == "2026-03-08T10:00:00Z"
    check payload[0]["frame_id"].getInt() == 1
    check payload[0]["metrics"]["cpuUsage"].getFloat() == 42.5
    check payload[0]["metrics"]["openFileDescriptors"].getInt() == 17
    check not payload[0]["metrics"].hasKey("event")

    let recentResponse = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/metrics/recent?since=2026-03-08T10%3A00%3A05Z&limit=1&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check recentResponse.status == 200
    let recentPayload = parseJson(recentResponse.body)["metrics"]
    check recentPayload.kind == JArray
    check recentPayload.len == 1
    check recentPayload[0]["id"].getStr() == "4"
    check recentPayload[0]["timestamp"].getStr() == "2026-03-08T10:00:20Z"

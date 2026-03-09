import std/[json, os, strutils, unittest]

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

  test "frame api endpoints work without login when panel auth is disabled":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "authEnabled": false,
    }
    configureServerState(config)

    let apps = httpRequest(server.port, "GET", "/api/apps?k=test-key")
    check apps.status == 200

    let frame = httpRequest(server.port, "GET", "/api/frames/1?k=test-key")
    check frame.status == 200

    let state = httpRequest(server.port, "GET", "/api/frames/1/state?k=test-key")
    check state.status == 200

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
      "/api/frames/2/image_token",
      "/api/frames/2/image",
    ]:
      let requestPath = if '?' in path: path else: path & "?k=test-key"
      let response = httpRequest(server.port, "GET", requestPath, headers = [("Cookie", adminCookie)])
      check response.status == 404

  test "image token uses frame access key fallback":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let noSession = httpRequest(server.port, "GET", "/api/frames/1/image_token?k=test-key")
    check noSession.status == 401

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminCookieFrom(login)

    let withKey = httpRequest(server.port, "GET", "/api/frames/1/image_token?k=test-key", headers = [("Cookie", adminCookie)])
    check withKey.status == 200
    check parseJson(withKey.body)["token"].getStr() == "test-key"

    config.frameAccessKey = ""
    config.frameAccess = "public"
    configureServerState(config)
    let fallback = httpRequest(server.port, "GET", "/api/frames/1/image_token", headers = [("Cookie", adminCookie)])
    check fallback.status == 200
    check parseJson(fallback.body)["token"].getStr() == "frame"

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

    let readOnlyToken = httpRequest(server.port, "GET", "/api/frames/1/image_token")
    check readOnlyToken.status == 401

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
      "/api/frames/1/image_token",
      headers = [("Cookie", adminCookie)],
    )
    check privilegedToken.status == 200
    check parseJson(privilegedToken.body)["token"].getStr() == "test-key"

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


  test "asset endpoints return 403 when asset access is disabled":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
      "permissions": %*{
        "accessAssets": false,
      },
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
    check listAssets.status == 403

    let getAsset = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=hello.txt&k=test-key",
      headers = [("Cookie", adminCookie)],
    )
    check getAsset.status == 403

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
      "line": $(%*{"event": "metrics", "cpuUsage": 42.5, "openFileDescriptors": 17}),
      "frame_id": 1,
    })
    storeUiLog(%*{
      "id": 2,
      "timestamp": "2026-03-08T10:00:05Z",
      "ip": "",
      "type": "webhook",
      "line": $(%*{"event": "http", "path": "/ping"}),
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
    check payload.len == 1
    check payload[0]["id"].getStr() == "1"
    check payload[0]["timestamp"].getStr() == "2026-03-08T10:00:00Z"
    check payload[0]["frame_id"].getInt() == 1
    check payload[0]["metrics"]["cpuUsage"].getFloat() == 42.5
    check payload[0]["metrics"]["openFileDescriptors"].getInt() == 17
    check not payload[0]["metrics"].hasKey("event")

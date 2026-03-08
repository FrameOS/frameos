import std/[json, os, strutils, unittest]

import ../../channels
import ./helpers/http_harness

var server = startRouterServer(19332)

proc adminCookieFrom(response: TestResponse): string =
  let cookie = response.header("set-cookie")
  if cookie.len == 0:
    return ""
  cookie.split(";", 1)[0]

suite "admin api route behavior":
  setup:
    drainEventChannel()

  test "disabled admin auth leaves admin session unauthenticated and login rejected":
    let config = defaultFrameConfig()
    configureServerState(config)

    let session = httpRequest(server.port, "GET", "/api/admin/session")
    check session.status == 200
    check not parseJson(session.body)["authenticated"].getBool()

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check login.status == 401
    check login.body.contains("Admin auth disabled")

  test "admin session, login, and logout flows":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let sessionBefore = httpRequest(server.port, "GET", "/api/admin/session")
    check sessionBefore.status == 200
    check not parseJson(sessionBefore.body)["authenticated"].getBool()

    let failedLogin = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "bad"}),
    )
    check failedLogin.status == 401

    let login = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check login.status == 200
    let adminCookie = adminCookieFrom(login)
    check adminCookie.contains("frame_admin_session=")

    let sessionAfter = httpRequest(
      server.port,
      "GET",
      "/api/admin/session",
      headers = [("Cookie", adminCookie)],
    )
    check sessionAfter.status == 200
    check parseJson(sessionAfter.body)["authenticated"].getBool()

    let logout = httpRequest(
      server.port,
      "POST",
      "/api/admin/logout",
      headers = [("Cookie", adminCookie)],
    )
    check logout.status == 200
    check logout.header("set-cookie").contains("frame_admin_session=;")

  test "event dispatch routes cover 401 404 400 and 200":
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

    let noSession = httpRequest(server.port, "POST", "/api/frames/1/event/test?k=test-key")
    check noSession.status == 401

    let adminSessionAccess = httpRequest(
      server.port,
      "POST",
      "/api/frames/1/event/test",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = "{}",
    )
    check adminSessionAccess.status == 200
    let (pathEventReceived, pathEventPayload) = eventChannel.tryRecv()
    check pathEventReceived
    check pathEventPayload[1] == "test"

    let wrongFrame = httpRequest(
      server.port,
      "POST",
      "/api/frames/2/event/test?k=test-key",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = "{}",
    )
    check wrongFrame.status == 404

    let missingEvent = httpRequest(
      server.port,
      "POST",
      "/api/frames/1/event?k=test-key",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = "{}",
    )
    check missingEvent.status == 400

    let ok = httpRequest(
      server.port,
      "POST",
      "/api/frames/1/event?k=test-key",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = $(%*{"event": "unit:test", "payload": %*{"value": 7}}),
    )
    check ok.status == 200
    let (received, eventPayload) = eventChannel.tryRecv()
    check received
    check eventPayload[1] == "unit:test"
    check eventPayload[2]["value"].getInt() == 7

  test "reload endpoint returns 200 and 500 for success and load failure":
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

    let tempRoot = getTempDir() / "frameos-admin-reload-tests"
    createDir(tempRoot)
    let configPath = tempRoot / "frame.json"
    writeFile(configPath, """{
      "mode": "web_only",
      "serverHost": "localhost",
      "serverPort": 8989,
      "frameHost": "localhost",
      "framePort": 8787,
      "frameAccess": "private",
      "frameAccessKey": "test-key",
      "width": 800,
      "height": 480
    }""")

    putEnv("FRAMEOS_CONFIG", configPath)
    let success = httpRequest(
      server.port,
      "POST",
      "/reload?k=test-key",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = "{}",
    )
    check success.status == 200

    putEnv("FRAMEOS_CONFIG", tempRoot / "missing.json")
    let failed = httpRequest(
      server.port,
      "POST",
      "/reload?k=test-key",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = "{}",
    )
    check failed.status == 500

  test "admin asset endpoints upload rename delete and download within assets root":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    let assetsRoot = getTempDir() / "frameos-admin-assets"
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

    let upload = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/upload?upload_id=test-upload&path=nested&filename=hello.txt&chunk_index=0&complete=0",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/octet-stream")],
      body = "he",
    )
    check upload.status == 200

    let uploadComplete = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/upload?upload_id=test-upload&path=nested&filename=hello.txt&chunk_index=1&complete=1",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/octet-stream")],
      body = "llo",
    )
    check uploadComplete.status == 200
    check fileExists(assetsRoot / "nested" / "hello.txt")

    let mkdir = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/mkdir",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/x-www-form-urlencoded")],
      body = "path=nested%2Finner",
    )
    check mkdir.status == 200
    check dirExists(assetsRoot / "nested" / "inner")

    let rename = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/rename",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/x-www-form-urlencoded")],
      body = "src=nested&dst=renamed",
    )
    check rename.status == 200
    check fileExists(assetsRoot / "renamed" / "hello.txt")

    let listAssets = httpRequest(
      server.port,
      "GET",
      "/api/admin/frames/1/assets",
      headers = [("Cookie", adminCookie)],
    )
    check listAssets.status == 200
    let assetsPayload = parseJson(listAssets.body)
    check assetsPayload["assets"].kind == JArray

    let download = httpRequest(
      server.port,
      "GET",
      "/api/admin/frames/1/asset?path=renamed%2Fhello.txt",
      headers = [("Cookie", adminCookie)],
    )
    check download.status == 200
    check download.body == "hello"

    let uploadImage = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/upload_image?upload_id=image-upload&filename=frame%20image.png&chunk_index=0&complete=1",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/octet-stream")],
      body = "hello",
    )
    check uploadImage.status == 200
    let uploadImagePayload = parseJson(uploadImage.body)
    check uploadImagePayload["path"].getStr().startsWith("uploads/frame_image.")
    check uploadImagePayload["filename"].getStr().endsWith(".png")

    let invalidDelete = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/delete",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/x-www-form-urlencoded")],
      body = "path=..%2Fsecret.txt",
    )
    check invalidDelete.status == 400

    let deleteRenamed = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/delete",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/x-www-form-urlencoded")],
      body = "path=renamed",
    )
    check deleteRenamed.status == 200
    check not dirExists(assetsRoot / "renamed")


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

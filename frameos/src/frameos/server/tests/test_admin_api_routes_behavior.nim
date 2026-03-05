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

    let noWriteAccess = httpRequest(
      server.port,
      "POST",
      "/api/frames/1/event/test",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = "{}",
    )
    check noWriteAccess.status == 401

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

import std/[json, os, strutils, times, unittest]
import pixie

import ../../channels
import ../../local_access
import ../../scenes
import ../../types
import ../../utils/http_client
import ../api
import ../rate_limit
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

  test "admin session cookies use Secure only for proxied https requests":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let httpLogin = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check httpLogin.status == 200
    check "Secure" notin httpLogin.header("set-cookie")

    let httpsLogin = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json"), ("X-Forwarded-Proto", "https")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check httpsLogin.status == 200
    check httpsLogin.header("set-cookie").contains("Secure")

    let httpsLogout = httpRequest(
      server.port,
      "POST",
      "/api/admin/logout",
      headers = [("Cookie", adminCookieFrom(httpsLogin)), ("X-Forwarded-Proto", "https")],
    )
    check httpsLogout.status == 200
    check httpsLogout.header("set-cookie").contains("Secure")

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

    # No "payload" key at all: `payload{"payload"}` is nil, and asking nil for
    # its `.kind` was a segfault that took the whole runtime down.
    let bare = httpRequest(
      server.port,
      "POST",
      "/api/frames/1/event",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
      body = $(%*{"event": "unit:bare"}),
    )
    check bare.status == 200
    let (bareReceived, barePayload) = eventChannel.tryRecv()
    check bareReceived
    check barePayload[1] == "unit:bare"
    check barePayload[2].kind == JObject
    check barePayload[2].len == 0

    # A body that is not JSON is the caller's mistake, not a 500.
    for path in ["/api/frames/1/event", "/api/frames/1/event/test"]:
      let garbled = httpRequest(
        server.port,
        "POST",
        path,
        headers = [("Cookie", adminCookie), ("Content-Type", "application/json")],
        body = "{not json",
      )
      check garbled.status == 400
    check not eventChannel.tryRecv()[0]

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

    let maliciousFilenameUpload = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/upload?upload_id=malicious-filename&path=nested&filename=..&chunk_index=0&complete=1",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/octet-stream")],
      body = "pw",
    )
    check maliciousFilenameUpload.status == 200
    let maliciousFilenamePayload = parseJson(maliciousFilenameUpload.body)
    check maliciousFilenamePayload["path"].getStr() == assetsRoot / "nested" / "uploaded_file"
    check fileExists(assetsRoot / "nested" / "uploaded_file")

    let maliciousPathUpload = httpRequest(
      server.port,
      "POST",
      "/api/admin/frames/1/assets/upload?upload_id=malicious-path&path=..%2Fescape&filename=hello.txt&chunk_index=0&complete=1",
      headers = [("Cookie", adminCookie), ("Content-Type", "application/octet-stream")],
      body = "pw",
    )
    check maliciousPathUpload.status == 400
    check maliciousPathUpload.body.contains("Invalid asset path")

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

    # path=%00: a NUL byte used to slip past the "not the assets root" guard
    # and removeDir() took the whole tree with it.
    writeFile(assetsRoot / "survivor.txt", "still here")
    for body in ["path=%00", "path=%2F", "path=%2F%00", "path=nested%00"]:
      let nulDelete = httpRequest(
        server.port,
        "POST",
        "/api/admin/frames/1/assets/delete",
        headers = [("Cookie", adminCookie), ("Content-Type", "application/x-www-form-urlencoded")],
        body = body,
      )
      check nulDelete.status == 400
    check dirExists(assetsRoot)
    check fileExists(assetsRoot / "survivor.txt")


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
      "/api/frames/1/assets",
      headers = [("Cookie", adminCookie)],
    )
    check listAssets.status == 200

    let getAsset = httpRequest(
      server.port,
      "GET",
      "/api/frames/1/asset?path=hello.txt",
      headers = [("Cookie", adminCookie)],
    )
    check getAsset.status == 200

proc adminLogin(): string =
  let login = httpRequest(
    server.port,
    "POST",
    "/api/admin/login",
    headers = [("Content-Type", "application/json")],
    body = $(%*{"username": "admin", "password": "secret"}),
  )
  check login.status == 200
  adminCookieFrom(login)

proc lanConfig(device: string): FrameConfig =
  result = defaultFrameConfig()
  result.frameAdminAuth = %*{"enabled": true, "user": "admin", "pass": "secret"}
  result.device = device

proc postJson(path: string, body: JsonNode, auth: (string, string)): TestResponse =
  httpRequest(server.port, "POST", path,
    headers = [("Content-Type", "application/json"), auth], body = $body)

suite "Local network access routes":
  ## The state file is a relative path, and the server thread shares this
  ## process's cwd: every case runs in its own temp directory.
  var previousDir = ""
  var sandbox = ""

  setup:
    drainEventChannel()
    resetRateLimits()
    previousDir = getCurrentDir()
    sandbox = getTempDir() / ("frameos-lan-access-routes-" & $epochTime() & "-" & $getCurrentProcessId())
    createDir(sandbox)
    setCurrentDir(sandbox)
    forgetStoredLocalNetworkAccess()
    clearLocalAccessChallenge()
    clearLocalAccessCodeOnPanel()
    resetLocalAccessWrongCodes()

  teardown:
    clearLocalAccessChallenge()
    clearLocalAccessCodeOnPanel()
    resetLocalAccessWrongCodes()
    setCurrentDir(previousDir)
    removeDir(sandbox)
    forgetStoredLocalNetworkAccess()
    setLocalNetworkPolicy(false)
    frameDriverPngHook = nil

  test "an admin session, never the access key or the backend's key":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let cookie = adminLogin()
    check httpRequest(server.port, "GET", "/api/network/local-access").status == 401
    # The frame access key opens the viewer, not this; the backend's
    # serverApiKey has no part in a cloud frame's ceremony either.
    check httpRequest(server.port, "GET", "/api/network/local-access?k=test-key").status == 401
    for bearer in ["test-key", "api"]:
      check postJson("/api/network/local-access/challenge", %*{},
        ("Authorization", "Bearer " & bearer)).status == 401
      check postJson("/api/network/local-access", %*{"enabled": false},
        ("Authorization", "Bearer " & bearer)).status == 401
    check httpRequest(server.port, "GET", "/api/network/local-access",
      headers = [("Authorization", "Bearer api")]).status == 401
    let viaSession = httpRequest(server.port, "GET", "/api/network/local-access",
      headers = [("Cookie", cookie)])
    check viaSession.status == 200
    let payload = parseJson(viaSession.body)
    for key in ["allowLocalNetworkAccess", "allowShellApps", "challengePending", "challengeSecondsLeft"]:
      check payload.hasKey(key)
    check postJson("/api/network/local-access/challenge", %*{}, ("Cookie", cookie)).status == 200
    check postJson("/api/network/local-access", %*{"enabled": false}, ("Cookie", cookie)).status == 200

  test "a frame without a panel cannot show a code":
    for device in ["web_only", "http.upload"]:
      configureServerState(lanConfig(device))
      let response = postJson("/api/network/local-access/challenge", %*{},
        ("Cookie", adminLogin()))
      check response.status == 409
      check parseJson(response.body)["error"].getStr() == "no_panel"
      check activeLocalAccessCode() == ""

  test "a challenge shows a code on the panel and never in the answer":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let admin = ("Cookie", adminLogin())
    let response = postJson("/api/network/local-access/challenge", %*{}, admin)
    check response.status == 200
    let body = parseJson(response.body)
    check body["status"].getStr() == "ok"
    check body["codeLength"].getInt() == 6
    check body["expiresInSeconds"].getFloat() == 300.0
    let code = activeLocalAccessCode()
    check code.len == 6
    check code notin response.body
    check localAccessPanelText() == "Local network access code\n" & code
    let unknown = postJson("/api/network/local-access/challenge", %*{"scope": "everything"}, admin)
    check unknown.status == 400
    check parseJson(unknown.body)["error"].getStr() == "invalid_lan_access"
    # The bad request left the pending code alone.
    check activeLocalAccessCode() == code

  test "off needs no code; on needs the one on the panel":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let admin = ("Cookie", adminLogin())
    let off = postJson("/api/network/local-access", %*{"enabled": false}, admin)
    check off.status == 200
    check parseJson(off.body)["allowLocalNetworkAccess"].getBool(true) == false
    check not lanAccessEnabled(nil)
    # A standalone frame: nothing to block, whatever the switch says.
    check not localNetworkPolicySnapshot().active

    let noCode = postJson("/api/network/local-access", %*{"enabled": true}, admin)
    check noCode.status == 403
    check parseJson(noCode.body)["error"].getStr() == "code_required"
    let noChallenge = postJson("/api/network/local-access", %*{"enabled": true, "code": "123456"}, admin)
    check noChallenge.status == 403
    check parseJson(noChallenge.body)["error"].getStr() == "code_expired"

    discard postJson("/api/network/local-access/challenge", %*{}, admin)
    let code = activeLocalAccessCode()
    let wrong = if code == "111111": "222222" else: "111111"
    let bad = postJson("/api/network/local-access", %*{"enabled": true, "code": wrong}, admin)
    check bad.status == 403
    check parseJson(bad.body)["error"].getStr() == "invalid_code"
    check not lanAccessEnabled(nil)

    let on = postJson("/api/network/local-access", %*{"enabled": true, "code": code}, admin)
    check on.status == 200
    check parseJson(on.body)["allowLocalNetworkAccess"].getBool(false) == true
    check lanAccessEnabled(nil)
    check activeLocalAccessCode() == ""
    check not localNetworkPolicySnapshot().active
    check parseJson(readFile(LocalAccessStatePath))["allowLocalNetworkAccess"].getBool(false)

  test "the scope is checked before the code is spent":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let admin = ("Cookie", adminLogin())
    persistLocalNetworkAccess(false)
    discard postJson("/api/network/local-access/challenge", %*{}, admin)
    let code = activeLocalAccessCode()
    # More bad requests than there are tries: none of them costs one.
    for _ in 0 .. LocalAccessMaxAttempts:
      for body in [%*{"enabled": true, "code": code, "scope": "everything"},
                   %*{"enabled": true, "code": code, "scope": 7},
                   %*{"enabled": "yes", "code": code},
                   %*{"code": code}]:
        let response = postJson("/api/network/local-access", body, admin)
        check response.status == 400
        check parseJson(response.body)["error"].getStr() == "invalid_lan_access"
      resetRateLimits()
    check activeLocalAccessCode() == code
    let invalidJson = httpRequest(server.port, "POST", "/api/network/local-access",
      headers = [("Content-Type", "application/json"), admin], body = "{nope")
    check invalidJson.status == 400
    # A local network access code is not a shell apps code.
    let shell = postJson("/api/network/local-access",
      %*{"enabled": true, "code": code, "scope": "shellApps"}, admin)
    check shell.status == 403
    check parseJson(shell.body)["error"].getStr() == "code_expired"
    check not storedAllowShellApps()
    check postJson("/api/network/local-access", %*{"enabled": true, "code": code}, admin).status == 200
    check lanAccessEnabled(nil)

  test "off takes a pending code off the panel":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let admin = ("Cookie", adminLogin())
    discard postJson("/api/network/local-access/challenge", %*{}, admin)
    check activeLocalAccessCode().len == 6
    check postJson("/api/network/local-access", %*{"enabled": false}, admin).status == 200
    check activeLocalAccessCode() == ""

  test "ten wrong codes in an hour answer 429 rate_limited to both routes":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let admin = ("Cookie", adminLogin())
    persistLocalNetworkAccess(false)
    for round in 0 ..< 2:
      resetRateLimits()
      check postJson("/api/network/local-access/challenge", %*{}, admin).status == 200
      let code = activeLocalAccessCode()
      let wrong = if code == "111111": "222222" else: "111111"
      for attempt in 1 .. LocalAccessMaxAttempts:
        check postJson("/api/network/local-access", %*{"enabled": true, "code": wrong}, admin).status == 403
    resetRateLimits()
    let challenge = postJson("/api/network/local-access/challenge", %*{}, admin)
    check challenge.status == 429
    let body = parseJson(challenge.body)
    check body["error"].getStr() == "rate_limited"
    check body["detail"].getStr() == "Too many wrong codes in the last hour. Try again later."
    let code = startLocalAccessChallenge().code
    let submit = postJson("/api/network/local-access", %*{"enabled": true, "code": code}, admin)
    check submit.status == 429
    check parseJson(submit.body)["error"].getStr() == "rate_limited"
    check activeLocalAccessCode() == code
    check not lanAccessEnabled(nil)

  test "the shell apps scope runs the same ceremony":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let admin = ("Cookie", adminLogin())
    discard postJson("/api/network/local-access/challenge", %*{"scope": "shellApps"}, admin)
    let code = activeLocalAccessCode()
    check localAccessPanelText() == "Shell apps code\n" & code
    let on = postJson("/api/network/local-access",
      %*{"enabled": true, "code": code, "scope": "shellApps"}, admin)
    check on.status == 200
    check parseJson(on.body)["allowShellApps"].getBool(false)
    check storedAllowShellApps()
    let off = postJson("/api/network/local-access",
      %*{"enabled": false, "scope": "shellApps"}, admin)
    check off.status == 200
    check not storedAllowShellApps()

  test "GET /image never hands out the driver's copy while a code may be on the panel":
    configureServerState(lanConfig("waveshare.EPD_7in5_V2"))
    let cookie = adminLogin()
    var stored = newImage(4, 4)
    stored.fill(rgba(255, 255, 255, 255))
    setLastImage(stored)
    frameDriverPngHook = proc(rotate: int, flip: string): string {.nimcall, gcsafe.} =
      "DRIVER-PNG"
    proc fetchImage(): string =
      let response = httpRequest(server.port, "GET", "/api/frames/1/image",
        headers = [("Cookie", cookie)])
      check response.status == 200
      response.body
    # No code: the driver's own PNG, as before.
    check fetchImage() == "DRIVER-PNG"
    # A code on the panel: the stored image, which never has it.
    markLocalAccessCodeOnPanel()
    let whileShown = fetchImage()
    check whileShown != "DRIVER-PNG"
    check decodeImage(whileShown).width == 4
    clearLocalAccessCodeOnPanel()
    check fetchImage() == "DRIVER-PNG"
    # A code that went out while the driver was encoding.
    frameDriverPngHook = proc(rotate: int, flip: string): string {.nimcall, gcsafe.} =
      markLocalAccessCodeOnPanel()
      clearLocalAccessCodeOnPanel()
      "DRIVER-PNG"
    check fetchImage() != "DRIVER-PNG"

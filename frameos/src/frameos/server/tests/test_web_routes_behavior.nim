import std/[json, strutils, unittest]

import ./helpers/http_harness

var server = startRouterServer(19331)

suite "web route behavior":
  test "root route handles hotspot and access-key redirects":
    var config = defaultFrameConfig()
    configureServerState(config, hotspotActive = true)
    let hotspotResponse = httpRequest(server.port, "GET", "/")
    check hotspotResponse.status == 200

    configureServerState(config, hotspotActive = false)
    let unauthorized = httpRequest(server.port, "GET", "/")
    check unauthorized.status == 401

    let authRedirect = httpRequest(server.port, "GET", "/?k=test-key")
    check authRedirect.status == 302
    check authRedirect.header("location") == "/"
    check authRedirect.header("set-cookie").contains("frame_access_key=test-key")

  test "admin and control routes enforce session/redirect expectations":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let adminNoSession = httpRequest(server.port, "GET", "/admin")
    check adminNoSession.status == 302
    check adminNoSession.header("location") == "/login"

    let adminLogin = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    let adminCookie = adminLogin.header("set-cookie").split(";", 1)[0]
    let adminWithSession = httpRequest(
      server.port,
      "GET",
      "/admin",
      headers = [("Cookie", adminCookie)],
    )
    check adminWithSession.status == 200

    config.frameAdminAuth = %*{}
    configureServerState(config)
    let adminUnauthorized = httpRequest(server.port, "GET", "/admin")
    check adminUnauthorized.status == 401
    check adminUnauthorized.body.contains("Admin auth disabled")

    let loginDisabled = httpRequest(server.port, "GET", "/login")
    check loginDisabled.status == 401
    check loginDisabled.body.contains("Admin auth disabled")

    let adminAccessKey = httpRequest(server.port, "GET", "/admin?k=test-key")
    check adminAccessKey.status == 401
    check adminAccessKey.body.contains("Admin auth disabled")

    let controlResponse = httpRequest(server.port, "GET", "/control")
    check controlResponse.status == 401
    check controlResponse.body.contains("Admin auth disabled")

    let logoutResponse = httpRequest(server.port, "GET", "/logout")
    check logoutResponse.status == 302
    check logoutResponse.header("location") == "/login"
    check logoutResponse.header("set-cookie").contains("frame_admin_session=;")

    let setupGet = httpRequest(server.port, "GET", "/setup")
    check setupGet.status == 302
    check setupGet.header("location") == "/"

  test "unauthorized gated routes return 401":
    let config = defaultFrameConfig()
    configureServerState(config)

    for path in ["/static/foo.js", "/image", "/states", "/state", "/ws", "/ws/admin"]:
      let response = httpRequest(server.port, "GET", path)
      check response.status == 401

  test "wifi route reflects hotspot mode":
    let config = defaultFrameConfig()

    configureServerState(config, hotspotActive = false)
    let notHotspot = httpRequest(server.port, "GET", "/wifi")
    check notHotspot.status == 400
    check notHotspot.body.contains("Not in setup mode")

    configureServerState(config, hotspotActive = true)
    let hotspot = httpRequest(server.port, "GET", "/wifi")
    check hotspot.status == 200
    let payload = parseJson(hotspot.body)
    check payload.hasKey("networks")

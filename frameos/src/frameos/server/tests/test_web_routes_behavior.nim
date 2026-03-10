import std/[json, strutils, unittest]

import ./helpers/http_harness
import ../auth

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

    let frameRootWithAdminSession = httpRequest(
      server.port,
      "GET",
      "/",
      headers = [("Cookie", adminCookie)],
    )
    check frameRootWithAdminSession.status == 401

    let controlWithAdminSession = httpRequest(
      server.port,
      "GET",
      "/c",
      headers = [("Cookie", adminCookie)],
    )
    check controlWithAdminSession.status == 401

    let adminWithFrameKey = httpRequest(server.port, "GET", "/admin?k=test-key")
    check adminWithFrameKey.status == 302
    check adminWithFrameKey.header("location") == "/login"
    check adminWithFrameKey.header("set-cookie") == ""

    let loginWithSession = httpRequest(
      server.port,
      "GET",
      "/login?__login_user=admin&__login_pass=secret",
      headers = [("Cookie", adminCookie)],
    )
    check loginWithSession.status == 302
    check loginWithSession.header("location") == "/admin"

    config.frameAdminAuth = %*{}
    configureServerState(config)
    let adminUnauthorized = httpRequest(server.port, "GET", "/admin")
    check adminUnauthorized.status == 401
    check adminUnauthorized.body.contains("Admin panel disabled")

    let loginDisabled = httpRequest(server.port, "GET", "/login")
    check loginDisabled.status == 401
    check loginDisabled.body.contains("Admin panel disabled")

    let adminAccessKey = httpRequest(server.port, "GET", "/admin?k=test-key")
    check adminAccessKey.status == 401
    check adminAccessKey.body.contains("Admin panel disabled")

    let controlResponse = httpRequest(server.port, "GET", "/control")
    check controlResponse.status == 401
    check controlResponse.body.contains("Admin panel disabled")

    let logoutResponse = httpRequest(server.port, "GET", "/logout")
    check logoutResponse.status == 302
    check logoutResponse.header("location") == "/login"
    check logoutResponse.header("set-cookie").contains("frame_admin_session=;")

    let setupGet = httpRequest(server.port, "GET", "/setup")
    check setupGet.status == 302
    check setupGet.header("location") == "/"

  test "legacy auth-disabled admin configs do not expose the admin routes":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "authEnabled": false,
    }
    configureServerState(config)

    let adminPage = httpRequest(server.port, "GET", "/admin")
    check adminPage.status == 401
    check adminPage.body.contains("Admin panel disabled")

    let loginPage = httpRequest(server.port, "GET", "/login")
    check loginPage.status == 401
    check loginPage.body.contains("Admin panel disabled")

  test "static assets load without frame auth when admin auth is enabled":
    var config = defaultFrameConfig()
    config.frameAdminAuth = %*{
      "enabled": true,
      "user": "admin",
      "pass": "secret",
    }
    configureServerState(config)

    let loginPage = httpRequest(server.port, "GET", "/login")
    check loginPage.status == 200

    let loginJs = httpRequest(server.port, "GET", "/static/main.js")
    check loginJs.status == 200

    let loginCss = httpRequest(server.port, "GET", "/static/main.css")
    check loginCss.status == 200

    let emittedAsset = httpRequest(server.port, "GET", "/static/asset-4X3RUWXO.png")
    check emittedAsset.status == 200

  test "static assets load without auth for public and protected frame access":
    var config = defaultFrameConfig()
    config.frameAccess = "public"
    configureServerState(config)

    let publicAsset = httpRequest(server.port, "GET", "/static/asset-4X3RUWXO.png")
    check publicAsset.status == 200

    config.frameAccess = "protected"
    configureServerState(config)

    let protectedAsset = httpRequest(server.port, "GET", "/static/asset-4X3RUWXO.png")
    check protectedAsset.status == 200

  test "private frames without admin auth require frame authentication for static assets":
    let config = defaultFrameConfig()
    configureServerState(config)

    let privateAsset = httpRequest(server.port, "GET", "/static/asset-4X3RUWXO.png")
    check privateAsset.status == 401

    let authedPrivateAsset = httpRequest(
      server.port,
      "GET",
      "/static/asset-4X3RUWXO.png",
      headers = [("Cookie", ACCESS_COOKIE & "=test-key")],
    )
    check authedPrivateAsset.status == 200

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

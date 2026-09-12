## Behavior tests for the cloud-managed enrollment route (flow A surface).
## Runs from a temp working directory so ./state/cloud_link.json never touches
## the developer checkout. Provider-side success paths are covered in
## src/frameos/cloud/tests/test_enrollment.nim with a stub provider; this file
## covers the local HTTP gate: auth, one-control-plane, input validation.

import std/[json, os, strutils, times, unittest]

import ../../channels
import ../rate_limit
import ./helpers/http_harness

let workDir = getTempDir() / ("frameos-test-cloud-routes-" & $(epochTime().int64) & "-" & $getCurrentProcessId())
createDir(workDir)
setCurrentDir(workDir)
putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", workDir / "cloud_device_key")

var server = startRouterServer(19335)

proc adminCookieFrom(response: TestResponse): string =
  let cookie = response.header("set-cookie")
  if cookie.len == 0:
    return ""
  cookie.split(";", 1)[0]

proc loginAsAdmin(): string =
  let login = httpRequest(
    server.port,
    "POST",
    "/api/admin/login",
    headers = [("Content-Type", "application/json")],
    body = $(%*{"username": "admin", "password": "secret"}),
  )
  doAssert login.status == 200
  adminCookieFrom(login)

proc adminConfig(serverHost: string): auto =
  var config = defaultFrameConfig()
  config.serverHost = serverHost
  config.frameAdminAuth = %*{"enabled": true, "user": "admin", "pass": "secret"}
  config

suite "cloud enroll route behavior":
  setup:
    drainEventChannel()

  test "enroll requires an admin session":
    configureServerState(adminConfig(""))
    let response = httpRequest(server.port, "POST", "/api/cloud/enroll",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"claim_token": "FRCT-x"}))
    check response.status == 401

  test "enroll refuses while a backend manages the frame":
    configureServerState(adminConfig("backend.example.com"))
    let cookie = loginAsAdmin()
    let response = httpRequest(server.port, "POST", "/api/cloud/enroll",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"claim_token": "FRCT-x"}))
    check response.status == 409
    check response.body.contains("self-hosted backend")

  test "enroll validates the claim token and JSON body":
    configureServerState(adminConfig(""))
    let cookie = loginAsAdmin()
    let missing = httpRequest(server.port, "POST", "/api/cloud/enroll",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"provider_url": "http://127.0.0.1:1"}))
    check missing.status == 400
    check missing.body.contains("claim_token")
    let invalidJson = httpRequest(server.port, "POST", "/api/cloud/enroll",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = "{nope")
    check invalidJson.status == 400

  test "enroll surfaces provider unreachability as 502":
    configureServerState(adminConfig(""))
    let cookie = loginAsAdmin()
    let response = httpRequest(server.port, "POST", "/api/cloud/enroll",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"claim_token": "FRCT-x", "provider_url": "http://127.0.0.1:1"}))
    check response.status == 502
    check parseJson(response.body){"error"}.getStr("").startsWith("network_error")
    # The failed enrollment must not leave a managed link behind.
    let status = httpRequest(server.port, "GET", "/api/cloud/status",
      headers = [("Cookie", cookie)])
    check status.status == 200
    let payload = parseJson(status.body)
    check payload{"status"}.getStr("") == "disconnected"
    check payload{"mode"}.getStr("") == ""

  test "status reports whether a self-hosted backend blocks managed mode":
    configureServerState(adminConfig("backend.example.com"))
    var cookie = loginAsAdmin()
    var status = httpRequest(server.port, "GET", "/api/cloud/status",
      headers = [("Cookie", cookie)])
    check status.status == 200
    check parseJson(status.body){"backend_managed"}.getBool(false)

    # The release-image "localhost" placeholder is not a backend.
    configureServerState(adminConfig("localhost"))
    cookie = loginAsAdmin()
    status = httpRequest(server.port, "GET", "/api/cloud/status",
      headers = [("Cookie", cookie)])
    check status.status == 200
    check not parseJson(status.body){"backend_managed"}.getBool(true)

proc writeLinkState(state: JsonNode) =
  createDir(workDir / "state")
  writeFile(workDir / "state" / "cloud_link.json", $state)

proc connectedLoginLink(localFallback: bool): JsonNode =
  %*{
    "status": "connected",
    "provider_url": "https://cloud.example.com",
    "scope": "frame:link auth:login",
    "access_token": "cloud-token",
    "local_fallback_enabled": localFallback,
  }

suite "cloud sign-in redirect target":
  setup:
    drainEventChannel()
    configureServerState(adminConfig(""))

  test "login/start never derives the redirect from the Host header":
    # No recorded local_origin: the provider would answer
    # invalid_redirect_uri, so the frame says what is wrong itself and
    # never reaches the provider with a Host-header-derived address.
    writeLinkState(connectedLoginLink(true))
    let missing = httpRequest(server.port, "POST", "/api/cloud/login/start",
      headers = [("Host", "attacker.example:8787")])
    check missing.status == 409
    check missing.body.contains("no local address on record")

    # A recorded origin is the redirect target; a browser on another origin
    # is pointed at the right one instead of bounced into a cookie mismatch.
    var state = connectedLoginLink(true)
    state["local_origin"] = %"http://kitchen.local:8787"
    writeLinkState(state)
    let elsewhere = httpRequest(server.port, "POST", "/api/cloud/login/start",
      headers = [("Host", "10.0.0.5:8787")])
    check elsewhere.status == 409
    check elsewhere.body.contains("http://kitchen.local:8787")
    # The matching origin passes the gate (and then fails only at the
    # unreachable stub provider).
    let matching = httpRequest(server.port, "POST", "/api/cloud/login/start",
      headers = [("Host", "KITCHEN.local:8787")])
    check matching.status == 502

suite "local password login can be handed to the cloud":
  setup:
    drainEventChannel()
    configureServerState(adminConfig(""))

  test "the login screen and the login route agree that passwords are off":
    writeLinkState(connectedLoginLink(false))
    let options = httpRequest(server.port, "GET", "/api/cloud/login/options")
    check options.status == 200
    let payload = parseJson(options.body)
    check payload{"available"}.getBool(false)
    check not payload{"local_login_enabled"}.getBool(true)

    let login = httpRequest(server.port, "POST", "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}))
    check login.status == 403
    check login.body.contains("Sign in with FrameOS Cloud")

  test "a link that is not connected leaves the password working":
    # The whole safety of the switch: no cloud, no lockout. Same stored flag,
    # opposite answer, because nothing can take the password's place.
    var state = connectedLoginLink(false)
    state["status"] = %"disconnected"
    writeLinkState(state)
    check parseJson(httpRequest(server.port, "GET", "/api/cloud/login/options").body){
      "local_login_enabled"}.getBool(false)
    check loginAsAdmin().len > 0

    # Same again for a live link that never carried auth:login.
    state = connectedLoginLink(false)
    state["scope"] = %"frame:link"
    writeLinkState(state)
    check loginAsAdmin().len > 0

  test "turning passwords off needs a cloud link, turning them on never does":
    writeLinkState(%*{"status": "disconnected", "local_fallback_enabled": false})
    let cookie = loginAsAdmin()

    let refused = httpRequest(server.port, "POST", "/api/cloud/local-fallback",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": false}))
    check refused.status == 409
    check refused.body.contains("auth:login")

    let restored = httpRequest(server.port, "POST", "/api/cloud/local-fallback",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": true}))
    check restored.status == 200
    check parseJson(restored.body){"local_fallback_enabled"}.getBool(false)
    check parseJson(readFile(workDir / "state" / "cloud_link.json")){
      "local_fallback_enabled"}.getBool(false)

  test "the switch is admin-only and validates its body":
    writeLinkState(%*{"status": "disconnected"})
    check httpRequest(server.port, "POST", "/api/cloud/local-fallback",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"enabled": true})).status == 401

    let cookie = loginAsAdmin()
    check httpRequest(server.port, "POST", "/api/cloud/local-fallback",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{})).status == 400

# One session for the whole suite: /api/admin/login is rate limited (ten
# attempts per window), and a suite that signs in per test would spend the
# budget the earlier suites left.
var switchesCookie = ""
proc switchAdminCookie(): string =
  if switchesCookie.len == 0:
    writeLinkState(connectedLoginLink(true))
    switchesCookie = loginAsAdmin()
  switchesCookie

suite "the two cloud switches on the admin page":
  setup:
    drainEventChannel()
    configureServerState(adminConfig(""))
    # /api/admin/login is throttled, and the suites above spend most of the
    # window's budget before this one starts.
    resetRateLimits()

  test "status names what each switch may do and whether it is on":
    var state = connectedLoginLink(true)
    state["scope"] = %"frame:link frame:managed auth:login"
    writeLinkState(state)
    let cookie = switchAdminCookie()
    writeLinkState(state)
    let payload = parseJson(httpRequest(server.port, "GET", "/api/cloud/status",
      headers = [("Cookie", cookie)]).body)
    check payload{"managed_available"}.getBool(false)
    check payload{"cloud_login_available"}.getBool(false)
    check payload{"cloud_login_enabled"}.getBool(false)
    # Linked but not managed: the panel must be able to say so.
    check payload{"mode"}.getStr("") == ""

  test "cloud login is a local switch, and turning it off brings the password back":
    # Sign in while the password still works, then put the frame in the state
    # the switch is meant to rescue: passwords off, everything resting on the
    # cloud button.
    let cookie = switchAdminCookie()
    writeLinkState(connectedLoginLink(false))
    check parseJson(httpRequest(server.port, "GET", "/api/cloud/login/options").body){
      "available"}.getBool(false)

    let off = httpRequest(server.port, "POST", "/api/cloud/cloud-login",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": false}))
    check off.status == 200
    let offPayload = parseJson(off.body)
    check not offPayload{"cloud_login_enabled"}.getBool(true)
    check offPayload{"local_fallback_enabled"}.getBool(false)
    # The grant is untouched; only this frame stopped offering the button.
    check offPayload{"cloud_login_available"}.getBool(false)
    let options = parseJson(httpRequest(server.port, "GET", "/api/cloud/login/options").body)
    check not options{"available"}.getBool(true)
    check options{"local_login_enabled"}.getBool(false)
    check loginAsAdmin().len > 0
    # Off means the handoff cannot be started either, not just that the
    # button stops being drawn.
    let start = httpRequest(server.port, "POST", "/api/cloud/login/start",
      headers = [("Host", "kitchen.local:8787")])
    check start.status == 403
    check start.body.contains("switched off")

    let on = httpRequest(server.port, "POST", "/api/cloud/cloud-login",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": true}))
    check on.status == 200
    check parseJson(on.body){"cloud_login_enabled"}.getBool(false)

  test "cloud login cannot be switched on without the grant":
    var state = connectedLoginLink(true)
    let cookie = switchAdminCookie()
    state["scope"] = %"frame:link"
    writeLinkState(state)
    let refused = httpRequest(server.port, "POST", "/api/cloud/cloud-login",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": true}))
    check refused.status == 409
    check refused.body.contains("auth:login")

  test "managed mode switches off locally and keeps the link":
    var state = connectedLoginLink(true)
    state["scope"] = %"frame:link frame:managed auth:login"
    state["mode"] = %"managed"
    state["frame_id"] = %"frm-1"
    state["ws_path"] = %"/api/frames/ws"
    let cookie = switchAdminCookie()
    writeLinkState(state)
    let off = httpRequest(server.port, "POST", "/api/cloud/managed",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": false}))
    check off.status == 200
    let payload = parseJson(off.body)
    check payload{"mode"}.getStr("") == ""
    check payload{"status"}.getStr("") == "connected"
    # Still offered, because the grant is still on the link.
    check payload{"managed_available"}.getBool(false)
    let stored = parseJson(readFile(workDir / "state" / "cloud_link.json"))
    check stored{"frame_id"}.getStr("") == ""
    check stored{"access_token"}.getStr("") == "cloud-token"

  test "managed mode cannot be switched on without the grant":
    var state = connectedLoginLink(true)
    let cookie = switchAdminCookie()
    state["scope"] = %"frame:link auth:login"
    writeLinkState(state)
    let refused = httpRequest(server.port, "POST", "/api/cloud/managed",
      headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
      body = $(%*{"enabled": true}))
    check refused.status == 409
    check refused.body.contains("connect again")

  test "both switches are admin-only and validate their body":
    let cookie = switchAdminCookie()
    writeLinkState(%*{"status": "disconnected"})
    for path in ["/api/cloud/managed", "/api/cloud/cloud-login"]:
      check httpRequest(server.port, "POST", path,
        headers = [("Content-Type", "application/json")],
        body = $(%*{"enabled": true})).status == 401
    for path in ["/api/cloud/managed", "/api/cloud/cloud-login"]:
      check httpRequest(server.port, "POST", path,
        headers = [("Content-Type", "application/json"), ("Cookie", cookie)],
        body = $(%*{})).status == 400

# No stopServer/removeDir teardown: like the other behavior tests, the mummy
# worker threads are torn down by process exit (an explicit close from the
# main thread races the workers), and the temp workDir lives under the OS
# temp root.

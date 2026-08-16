## Behavior tests for the cloud-managed enrollment route (flow A surface).
## Runs from a temp working directory so ./state/cloud_link.json never touches
## the developer checkout. Provider-side success paths are covered in
## src/frameos/cloud/tests/test_enrollment.nim with a stub provider; this file
## covers the local HTTP gate: auth, one-control-plane, input validation.

import std/[json, os, strutils, times, unittest]

import ../../channels
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

# No stopServer/removeDir teardown: like the other behavior tests, the mummy
# worker threads are torn down by process exit (an explicit close from the
# main thread races the workers), and the temp workDir lives under the OS
# temp root.

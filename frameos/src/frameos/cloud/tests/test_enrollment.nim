## Enrollment behavior tests: a tiny mummy server plays the provider so no
## real network is involved. The test chdirs into a temp dir so the relative
## ./state/cloud_link.json paths stay isolated from the repo checkout.

import std/[json, locks, net, os, strutils, times, unittest]
import mummy
import mummy/routers

import ../enrollment
import ../identity
import ../link_state
import ../../types

const TestPort = 19461

let workDir = getTempDir() / ("frameos-test-enrollment-" & $(epochTime().int64) & "-" & $getCurrentProcessId())
createDir(workDir)
setCurrentDir(workDir)
putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", workDir / "cloud_device_key")
putEnv("FRAMEOS_CLOUD_ENROLL_PENDING_PATH", workDir / "cloud_enroll_pending.json")

# ---------------------------------------------------------------------------
# Provider stub
# ---------------------------------------------------------------------------

var stubLock: Lock
initLock(stubLock)
var receivedBodies: seq[JsonNode]
var receivedAuthHeaders: seq[string]
var nextResponseCode = 200
var nextResponseBody = ""

proc setStubResponse(code: int, body: JsonNode) =
  withLock stubLock:
    nextResponseCode = code
    nextResponseBody = $body
    receivedBodies = @[]
    receivedAuthHeaders = @[]

proc recordedRequests(): (seq[JsonNode], seq[string]) =
  withLock stubLock:
    result = (receivedBodies, receivedAuthHeaders)

var router: Router
router.post("/api/frames/enroll", proc(request: Request) {.gcsafe.} =
  {.gcsafe.}:
    var code = 200
    var body = ""
    withLock stubLock:
      try:
        receivedBodies.add(parseJson(request.body))
      except CatchableError:
        receivedBodies.add(%*{})
      var auth = ""
      for (name, value) in request.headers:
        if cmpIgnoreCase(name, "authorization") == 0:
          auth = value
      receivedAuthHeaders.add(auth)
      code = nextResponseCode
      body = nextResponseBody
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    request.respond(code, headers, body)
)

var server = newServer(router.toHandler(), workerThreads = 1)
var serverThread: Thread[(mummy.Server, Port)]
proc serveStub(args: (mummy.Server, Port)) {.thread.} =
  try:
    args[0].serve(args[1], "127.0.0.1")
  except CatchableError:
    discard
createThread(serverThread, serveStub, (server, Port(TestPort)))
sleep(200)

let providerUrl = "http://127.0.0.1:" & $TestPort

proc standaloneConfig(): FrameConfig =
  FrameConfig(name: "Test frame", mode: "buildroot", device: "web_only",
              width: 800, height: 480, serverHost: "")

proc linkState(): JsonNode =
  withLock cloudLinkLock:
    result = loadCloudLinkState()

proc clearLinkState() =
  withLock cloudLinkLock:
    if fileExists(CLOUD_LINK_STATE_PATH):
      removeFile(CLOUD_LINK_STATE_PATH)

suite "cloud enrollment":
  test "claim-token enrollment stores a managed link":
    clearLinkState()
    setStubResponse(200, %*{
      "access_token": "frame-token-1",
      "token_type": "Bearer",
      "scope": "frame:managed telemetry:logs",
      "frame_id": "frame-abc",
      "status": "pending",
      "ws_path": "/api/frames/ws",
    })
    let outcome = enrollManagedFrame(providerUrl, "FRCT-test-1", "", "Kitchen", standaloneConfig())
    check outcome.ok
    let (bodies, authHeaders) = recordedRequests()
    check bodies.len == 1
    check bodies[0]{"claim_token"}.getStr("") == "FRCT-test-1"
    check bodies[0]{"name"}.getStr("") == "Kitchen"
    check bodies[0]{"public_key"}.getStr("").len > 0
    check bodies[0]{"hardware"}{"platform"}.getStr("") == "buildroot"
    check bodies[0]{"hardware"}{"width"}.getInt(0) == 800
    check authHeaders[0] == ""
    let state = linkState()
    check state{"mode"}.getStr("") == "managed"
    check state{"status"}.getStr("") == "connected"
    check state{"access_token"}.getStr("") == "frame-token-1"
    check state{"frame_id"}.getStr("") == "frame-abc"
    check state{"ws_path"}.getStr("") == "/api/frames/ws"
    check state{"scope"}.getStr("") == "frame:managed telemetry:logs"
    check isManagedLink(state)
    check hasDeviceKeypair()
    # The persisted state file is 0600.
    when not defined(windows):
      let permissions = getFilePermissions(CLOUD_LINK_STATE_PATH)
      for other in [fpGroupRead, fpOthersRead]:
        check other notin permissions

  test "enrollment is refused while a backend manages this frame":
    clearLinkState()
    setStubResponse(200, %*{"access_token": "x", "frame_id": "y"})
    var config = standaloneConfig()
    config.serverHost = "backend.example.com"
    let outcome = enrollManagedFrame(providerUrl, "FRCT-test-2", "", "", config)
    check not outcome.ok
    check outcome.status == 409
    check outcome.error == "backend_managed"
    check not outcome.retryable
    # Never even talked to the provider.
    check recordedRequests()[0].len == 0
    check not isManagedLink(linkState())

  test "provider rejection is surfaced and not retryable":
    clearLinkState()
    setStubResponse(400, %*{"error": "invalid_claim_token"})
    let outcome = enrollManagedFrame(providerUrl, "FRCT-dead", "", "", standaloneConfig())
    check not outcome.ok
    check outcome.status == 400
    check outcome.error == "invalid_claim_token"
    check not outcome.retryable
    check not isManagedLink(linkState())

  test "5xx and network errors are retryable":
    clearLinkState()
    setStubResponse(503, %*{"error": "overloaded"})
    check enrollManagedFrame(providerUrl, "FRCT-x", "", "", standaloneConfig()).retryable
    let dead = enrollManagedFrame("http://127.0.0.1:1", "FRCT-x", "", "", standaloneConfig())
    check not dead.ok
    check dead.retryable

  test "pending boot enrollment file is consumed on success":
    clearLinkState()
    setStubResponse(200, %*{
      "access_token": "frame-token-2",
      "scope": "frame:managed",
      "frame_id": "frame-boot",
      "ws_path": "/api/frames/ws",
    })
    writeFile(pendingEnrollmentPath(), $(%*{
      "claim_token": "FRCT-boot-1",
      "provider_url": providerUrl,
      "name": "Boot frame",
    }))
    let (resolved, attempted, outcome) = processPendingCloudEnrollment(standaloneConfig())
    check resolved and attempted and outcome.ok
    check not fileExists(pendingEnrollmentPath())
    let state = linkState()
    check state{"mode"}.getStr("") == "managed"
    check state{"frame_id"}.getStr("") == "frame-boot"
    let (bodies, _) = recordedRequests()
    check bodies[0]{"name"}.getStr("") == "Boot frame"

  test "pending enrollment with a dead token is dropped, not retried":
    clearLinkState()
    setStubResponse(400, %*{"error": "invalid_claim_token"})
    writeFile(pendingEnrollmentPath(), $(%*{
      "claim_token": "FRCT-boot-dead",
      "provider_url": providerUrl,
    }))
    let (resolved, attempted, outcome) = processPendingCloudEnrollment(standaloneConfig())
    check resolved and attempted and not outcome.ok
    check not fileExists(pendingEnrollmentPath())
    check not isManagedLink(linkState())

  test "pending enrollment retries on network errors until expiry":
    clearLinkState()
    writeFile(pendingEnrollmentPath(), $(%*{
      "claim_token": "FRCT-boot-retry",
      "provider_url": "http://127.0.0.1:1",
    }))
    let (resolved, attempted, outcome) = processPendingCloudEnrollment(standaloneConfig())
    check attempted and not resolved and outcome.retryable
    check fileExists(pendingEnrollmentPath())
    # The first attempt stamps a default expiry into the pending file.
    let pending = parseJson(readFile(pendingEnrollmentPath()))
    check pending{"expires_epoch"}.getInt(0) > int(epochTime())
    # An expired pending file resolves without another provider call.
    pending["expires_epoch"] = %(int(epochTime()) - 10)
    writeFile(pendingEnrollmentPath(), $pending)
    let (resolvedAfter, attemptedAfter, outcomeAfter) = processPendingCloudEnrollment(standaloneConfig())
    check resolvedAfter and not attemptedAfter
    check outcomeAfter.error == "claim_token_expired"
    check not fileExists(pendingEnrollmentPath())

  test "a pre-NTP expiry stamp is discarded, not treated as expired":
    # A Pi Zero has no RTC: the hub thread's first pass stamped
    # "now + 24h" while the clock still read 2025, NTP then jumped the
    # clock forward, and the next pass deleted the pending enrollment as
    # expired — no request ever left the frame. The bogus stamp must be
    # discarded and the enrollment must still go through.
    clearLinkState()
    setStubResponse(200, %*{
      "access_token": "frame-token-ntp",
      "scope": "frame:managed",
      "frame_id": "frame-ntp",
      "ws_path": "/api/frames/ws",
    })
    writeFile(pendingEnrollmentPath(), $(%*{
      "claim_token": "FRCT-boot-ntp",
      "provider_url": providerUrl,
      # What a pre-NTP clock stamps: far in the past relative to real time,
      # below the sanity epoch.
      "expires_epoch": PENDING_ENROLL_CLOCK_SANITY_EPOCH - 1000,
    }))
    let (resolved, attempted, outcome) = processPendingCloudEnrollment(standaloneConfig())
    check resolved and attempted and outcome.ok
    check not fileExists(pendingEnrollmentPath())
    check linkState(){"frame_id"}.getStr("") == "frame-ntp"

  test "device-flow bearer enrollment upgrades an existing link":
    clearLinkState()
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["provider_url"] = %providerUrl
      state["status"] = %"connected"
      state["access_token"] = %"bearer-token-1"
      state["scope"] = %"frame:link frame:managed"
      saveCloudLinkState(state)
    setStubResponse(200, %*{"frame_id": "frame-flow-b", "ws_path": "/api/frames/ws",
                            "scope": "frame:managed telemetry:metrics"})
    let outcome = enrollManagedFrame(providerUrl, "", "bearer-token-1", "", standaloneConfig())
    check outcome.ok
    let (bodies, authHeaders) = recordedRequests()
    check bodies.len == 1
    check not bodies[0].hasKey("claim_token")
    check bodies[0]{"public_key"}.getStr("").len > 0
    check authHeaders[0] == "Bearer bearer-token-1"
    let state = linkState()
    check state{"mode"}.getStr("") == "managed"
    check state{"frame_id"}.getStr("") == "frame-flow-b"
    # The device-flow token stays; flow B never mints a new one.
    check state{"access_token"}.getStr("") == "bearer-token-1"
    # The enroll response's scope is merged in, not substituted.
    check state{"scope"}.getStr("") == "frame:link frame:managed telemetry:metrics"

  test "flow B keeps every scope the device-flow grant already carried":
    clearLinkState()
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["provider_url"] = %providerUrl
      state["status"] = %"connected"
      state["access_token"] = %"bearer-token-2"
      state["scope"] = %"frame:link frame:managed auth:login telemetry:logs"
      saveCloudLinkState(state)
    # The enroll endpoint always answers with just the managed scope.
    setStubResponse(200, %*{"frame_id": "frame-flow-b2", "ws_path": "/api/frames/ws",
                            "scope": "frame:managed"})
    check enrollManagedFrame(providerUrl, "", "bearer-token-2", "", standaloneConfig()).ok
    let scopes = linkScopes(linkState())
    for scope in ["frame:link", "frame:managed", "auth:login", "telemetry:logs"]:
      check scope in scopes
    # Merged, not duplicated.
    check scopes.len == 4

  test "the pending enrollment file is shredded, not just unlinked":
    clearLinkState()
    setStubResponse(200, %*{
      "access_token": "frame-token-3",
      "scope": "frame:managed",
      "frame_id": "frame-shred",
      "ws_path": "/api/frames/ws",
    })
    let path = pendingEnrollmentPath()
    writeFile(path, $(%*{"claim_token": "FRCT-secret-shred", "provider_url": providerUrl}))
    # Keep the inode alive so we can read what was left behind on disk.
    let copyPath = path & ".hardlink"
    createHardlink(path, copyPath)
    let (resolved, _, outcome) = processPendingCloudEnrollment(standaloneConfig())
    check resolved and outcome.ok
    check not fileExists(path)
    check "FRCT-secret-shred" notin readFile(copyPath)
    removeFile(copyPath)

  test "disconnect-style reset clears the managed fields":
    let before = linkState()
    check before{"mode"}.getStr("") == "managed"
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      resetLinkState(state)
      saveCloudLinkState(state)
    let state = linkState()
    check state{"status"}.getStr("") == "disconnected"
    for key in ["mode", "frame_id", "ws_path", "access_token", "scenes_checksum"]:
      check not state.hasKey(key)

# No server.close(): it segfaults in mummy's shutdown path *after* the suite
# has passed, turning a green run into exit code 1. It reproduces on demand —
# adding close() to test_hub_session.nim (which never had one and never failed)
# crashes it the same way every time. The stub server dies with the process,
# which is all this test needs.
removeDir(workDir)

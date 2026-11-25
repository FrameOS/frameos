## Device-flow ("link code") behavior tests: a tiny mummy server plays the
## provider, so the start/poll/tick lifecycle runs for real with no network.
## Chdirs into a temp dir so ./state/cloud_link.json stays isolated.

import std/[json, locks, net, os, strutils, tables, times, unittest]
import mummy
import mummy/routers

import ../device_flow
import ../link_state
import ../../types

const TestPort = 19462

let workDir = getTempDir() / ("frameos-test-device-flow-" & $(epochTime().int64) & "-" & $getCurrentProcessId())
createDir(workDir)
setCurrentDir(workDir)
putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", workDir / "cloud_device_key")
putEnv("FRAMEOS_CLOUD_LINK_CODE_PENDING_PATH", workDir / "cloud_link_code_pending.json")

# ---------------------------------------------------------------------------
# Provider stub: per-path canned responses, requests recorded.
# ---------------------------------------------------------------------------

var stubLock: Lock
initLock(stubLock)
var responses = initTable[string, (int, string)]()
var requestCounts = initTable[string, int]()

proc setStubResponse(path: string, code: int, body: JsonNode) =
  withLock stubLock:
    responses[path] = (code, $body)
    requestCounts[path] = 0

proc requestCount(path: string): int =
  withLock stubLock:
    result = requestCounts.getOrDefault(path, 0)

proc stubHandler(request: Request) {.gcsafe.} =
  {.gcsafe.}:
    var code = 404
    var body = "{}"
    withLock stubLock:
      requestCounts[request.path] = requestCounts.getOrDefault(request.path, 0) + 1
      if responses.hasKey(request.path):
        (code, body) = responses[request.path]
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    request.respond(code, headers, body)

var router: Router
router.post("/**", stubHandler)
router.get("/**", stubHandler)

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
              width: 800, height: 480, serverHost: "", frameHost: "test.local",
              framePort: 8787)

proc linkStateNow(): JsonNode =
  withLock cloudLinkLock:
    result = loadCloudLinkState()

proc clearLinkState() =
  withLock cloudLinkLock:
    if fileExists(CLOUD_LINK_STATE_PATH):
      removeFile(CLOUD_LINK_STATE_PATH)
    let state = loadCloudLinkState()
    saveCloudLinkState(state)

proc startResponse(): JsonNode =
  %*{
    "device_code": "dev-code-1",
    "user_code": "ABCD-2345",
    "verification_uri": providerUrl & "/device",
    "verification_uri_complete": providerUrl & "/device?user_code=ABCD-2345",
    "interval": 1,
    "expires_in": 600,
  }

suite "device flow start and panel view":
  test "a successful start pends the link and puts the code on the panel":
    clearLinkState()
    clearPendingLinkCode()
    setStubResponse("/api/device/start", 200, startResponse())
    let outcome = startDeviceFlow(providerUrl, "Test frame", "http://test.local:8787",
      @["frame:link"])
    check outcome.ok
    let state = linkStateNow()
    check state{"status"}.getStr("") == "connecting"
    check state{"user_code"}.getStr("") == "ABCD-2345"
    let view = activeLinkCode()
    check view.active
    check view.userCode == "ABCD-2345"
    check view.verificationUriComplete.contains("user_code=ABCD-2345")
    check view.secondsLeft > 0

  test "a provider rejection reports the error and pends nothing":
    clearLinkState()
    setStubResponse("/api/device/start", 400, %*{"error": "nope"})
    let outcome = startDeviceFlow(providerUrl, "Test frame", "http://test.local:8787",
      @["frame:link"])
    check not outcome.ok
    check not outcome.networkError
    check outcome.error.contains("nope")
    check linkStateNow(){"status"}.getStr("disconnected") == "disconnected"
    check not activeLinkCode().active

  test "an unreachable provider is a retryable network error":
    let outcome = startDeviceFlow("http://127.0.0.1:1", "Test frame",
      "http://test.local:8787", @["frame:link"])
    check not outcome.ok
    check outcome.networkError

suite "device flow poll":
  setup:
    clearLinkState()
    clearPendingLinkCode()
    setStubResponse("/api/device/start", 200, startResponse())
    discard startDeviceFlow(providerUrl, "Test frame", "http://test.local:8787",
      @["frame:link"])

  test "authorization_pending keeps the code up":
    setStubResponse("/api/device/poll", 428, %*{"error": "authorization_pending"})
    let poll = pollDeviceFlow(standaloneConfig())
    check poll.polled
    check not poll.changed
    check linkStateNow(){"status"}.getStr("") == "connecting"
    check activeLinkCode().active

  test "approval connects the link and takes the code down":
    setStubResponse("/api/device/poll", 200, %*{
      "access_token": "link-token-1",
      "token_reference": "ref-1",
      "linked_client_id": "client-1",
      "scope": "frame:link",
    })
    setStubResponse("/api/backends/inventory", 200, %*{"status": "ok"})
    setStubResponse("/api/backends/grants", 200, %*{"grants": []})
    let poll = pollDeviceFlow(standaloneConfig())
    check poll.changed
    check not poll.startHub
    let state = linkStateNow()
    check state{"status"}.getStr("") == "connected"
    check state{"access_token"}.getStr("") == "link-token-1"
    check not state.hasKey("user_code")
    check not activeLinkCode().active

  test "an approval that answers with more than was asked for grants only what was asked":
    # The flow asked for frame:link. A provider naming cloud login and
    # management in its answer does not get them on its say-so.
    setStubResponse("/api/device/poll", 200, %*{
      "access_token": "link-token-2",
      "token_reference": "ref-2",
      "linked_client_id": "client-2",
      "scope": "frame:link auth:login frame:managed",
    })
    setStubResponse("/api/backends/inventory", 200, %*{"status": "ok"})
    setStubResponse("/api/backends/grants", 200, %*{"grants": []})
    let poll = pollDeviceFlow(standaloneConfig())
    check poll.changed
    check not poll.startHub
    let state = linkStateNow()
    check state{"status"}.getStr("") == "connected"
    check state{"scope"}.getStr("") == "frame:link"

  test "denial resets the link and records why":
    setStubResponse("/api/device/poll", 403, %*{"error": "access_denied"})
    let poll = pollDeviceFlow(standaloneConfig())
    check poll.changed
    let state = linkStateNow()
    check state{"status"}.getStr("") == "disconnected"
    check state{"poll_error"}.getStr("") == "access_denied"
    check not activeLinkCode().active

  test "an expired window takes the code down before any poll":
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["expires_epoch"] = %(int(epochTime()) - 5)
      saveCloudLinkState(state)
    check not activeLinkCode().active
    let poll = pollDeviceFlow(standaloneConfig())
    check poll.changed
    check linkStateNow(){"status"}.getStr("") == "disconnected"

suite "queued panel link code":
  test "the tick starts a device flow for a queued link code":
    clearLinkState()
    setStubResponse("/api/device/start", 200, startResponse())
    check writePendingLinkCode(providerUrl)
    check pendingLinkCodeQueued()
    discard deviceFlowTick(standaloneConfig())
    check linkStateNow(){"status"}.getStr("") == "connecting"
    check activeLinkCode().active
    # The marker survives (it restarts the flow when the window lapses) and
    # counts the start.
    check loadPendingLinkCode(){"starts"}.getInt(0) == 1

  test "connecting ticks poll without a browser":
    setStubResponse("/api/device/poll", 428, %*{"error": "authorization_pending"})
    discard deviceFlowTick(standaloneConfig())
    # interval is 1 s; wait it out so the tick actually polls.
    sleep(1100)
    discard deviceFlowTick(standaloneConfig())
    check requestCount("/api/device/poll") >= 1
    check linkStateNow(){"status"}.getStr("") == "connecting"

  test "a connected link retires the queued marker":
    clearLinkState()
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["status"] = %"connected"
      saveCloudLinkState(state)
    check writePendingLinkCode(providerUrl)
    discard deviceFlowTick(standaloneConfig())
    check not pendingLinkCodeQueued()

  test "a managed frame never starts a queued code, and drops the marker":
    clearLinkState()
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      state["mode"] = %"managed"
      state["status"] = %"disconnected"
      saveCloudLinkState(state)
    setStubResponse("/api/device/start", 200, startResponse())
    let before = requestCount("/api/device/start")
    check writePendingLinkCode(providerUrl)
    discard deviceFlowTick(standaloneConfig())
    check requestCount("/api/device/start") == before
    check not pendingLinkCodeQueued()
    check not activeLinkCode().active
  test "a permanent provider refusal stops the queued link and says why":
    clearLinkState()
    setStubResponse("/api/device/start", 400, %*{"error": "invalid_request"})
    check writePendingLinkCode(providerUrl)
    discard deviceFlowTick(standaloneConfig())
    # Kept for the frame page, which says why until Cancel or Try again.
    let pending = loadPendingLinkCode()
    check pending{"failed"}.getStr() == "reach"
    check pending{"detail"}.getStr() == "HTTP 400"
    check pending{"stopped"}.getBool()
    check linkStateNow(){"status"}.getStr("disconnected") == "disconnected"
    # Stopped: no more starts.
    let before = requestCount("/api/device/start")
    discard deviceFlowTick(standaloneConfig())
    check requestCount("/api/device/start") == before
    # Try again queues it afresh.
    setStubResponse("/api/device/start", 200, startResponse())
    check writePendingLinkCode(providerUrl)
    discard deviceFlowTick(standaloneConfig())
    check activeLinkCode().active
    check loadPendingLinkCode(){"failed"}.isNil
    clearPendingLinkCode()

  test "the tick gives up after the start budget is spent":
    clearLinkState()
    setStubResponse("/api/device/start", 200, startResponse())
    check writePendingLinkCode(providerUrl)
    let pending = loadPendingLinkCode()
    pending["starts"] = %LINK_CODE_MAX_STARTS
    writeFile(pendingLinkCodePath(), $pending & "\n")
    discard deviceFlowTick(standaloneConfig())
    check loadPendingLinkCode(){"failed"}.getStr() == "lapsed"
    check loadPendingLinkCode(){"stopped"}.getBool()
    check linkStateNow(){"status"}.getStr("disconnected") == "disconnected"
    clearPendingLinkCode()

  test "the frame page's link stops at its deadline and does not outlive the process":
    clearLinkState()
    clearPendingLinkCode()
    setStubResponse("/api/device/start", 200, startResponse())
    check writePendingLinkCode(providerUrl, epochTime() + PANEL_LINK_SECONDS.float)
    discard deviceFlowTick(standaloneConfig())
    check activeLinkCode().active
    # Its time is up: the code comes off the panel and the page says why.
    let pending = loadPendingLinkCode()
    pending["until"] = %(epochTime() - 1)
    writeFile(pendingLinkCodePath(), $pending & "\n")
    discard deviceFlowTick(standaloneConfig())
    check not activeLinkCode().active
    check loadPendingLinkCode(){"failed"}.getStr() == "lapsed"
    check linkStateNow(){"status"}.getStr("disconnected") == "disconnected"
    # A restart (a crash) ends a page's link outright, and leaves the
    # setup portal's, which has no deadline, alone.
    check writePendingLinkCode(providerUrl, epochTime() + PANEL_LINK_SECONDS.float)
    discard deviceFlowTick(standaloneConfig())
    check activeLinkCode().active
    dropPanelLinkAtStart()
    check not pendingLinkCodeQueued()
    check not activeLinkCode().active
    check writePendingLinkCode(providerUrl)
    dropPanelLinkAtStart()
    check pendingLinkCodeQueued()
    clearPendingLinkCode()

  test "an unreachable provider is noted on the queued link, which keeps trying":
    clearLinkState()
    clearPendingLinkCode()
    check writePendingLinkCode("http://127.0.0.1:1")
    discard deviceFlowTick(standaloneConfig())
    let pending = loadPendingLinkCode()
    check pending{"failed"}.getStr() == "reach"
    check not pending{"stopped"}.getBool()
    clearPendingLinkCode()

import std/[deques, json, locks, net, os, strutils, tables]
import mummy
import mummy/routers

import ../../[auth, routes, state]
import ../../../[channels, scenes, types]
import ../../../portal
from scenes/scenes import sceneOptions

type
  TestServer* = object
    server*: mummy.Server
    listener*: Listener
    port*: int
    thread*: Thread[tuple[server: mummy.Server, port: Port]]
  TestResponse* = object
    status*: int
    headers*: Table[string, string]
    body*: string

var recentLogsLockInitialized = false
let missingConfigPath = getTempDir() / ("frameos-server-tests-missing-frame-" & $getCurrentProcessId() & ".json")

proc serverThread(args: tuple[server: mummy.Server, port: Port]) {.thread.} =
  try:
    # The listener was added by startRouterServer, so its handle is known to
    # the tests (listener_control rebinds by handle).
    args.server.serve()
  except CatchableError:
    discard

proc drainEventChannel*() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok:
      break

proc defaultFrameConfig*(): FrameConfig =
  FrameConfig(
    name: "Test Frame",
    mode: "web_only",
    frameHost: "localhost",
    framePort: 8787,
    frameAccess: "private",
    frameAccessKey: "test-key",
    frameAdminAuth: %*{},
    serverHost: "localhost",
    serverPort: 8989,
    serverApiKey: "api",
    width: 800,
    height: 480,
    rotate: 0,
    flip: "",
    scalingMode: "contain",
    device: "web_only",
    metricsInterval: 60,
    saveAssets: %*(false),
    network: NetworkConfig(
      networkCheck: false,
      networkCheckTimeoutSeconds: 30,
      networkCheckUrl: "https://networkcheck.frameos.net",
      wifiHotspot: "disabled",
      wifiHotspotSsid: "FrameOS-Setup",
      wifiHotspotPassword: "frame1234",
      wifiHotspotTimeoutSeconds: 300,
    ),
  )

proc portalRunHookForServerTests(cmd: string): (string, int) {.gcsafe, nimcall.} =
  # Pin the NetworkManager backend: these tests exercise the HTTP routes, not
  # the backend detection in frameos/network/backend.nim.
  if cmd.contains("command -v nmcli"):
    return ("nmcli\n", 0)
  if cmd.contains("nmcli -t -f RUNNING general status"):
    return ("running\n", 0)
  if cmd.contains("nmcli --terse --fields SSID device wifi list"):
    return ("test-network\n", 0)
  if cmd.contains("nmcli --colors no -t -f NAME connection show --active"):
    return ("", 0)
  if cmd.contains("nmcli --colors no -t -f NAME connection show"):
    return ("frameos-wifi\n", 0)
  ("", 0)

proc portalSleepHookNoop(ms: int) {.gcsafe, nimcall.} =
  discard

proc portalAutoTimeoutDisabled(): bool {.gcsafe, nimcall.} =
  false

proc configureServerState*(config: FrameConfig, hotspotActive = false) =
  if not existsEnv("FRAMEOS_CONFIG"):
    if fileExists(missingConfigPath):
      removeFile(missingConfigPath)
    putEnv("FRAMEOS_CONFIG", missingConfigPath)
  setPortalHooksForTest(
    runHook = portalRunHookForServerTests,
    sleepHook = portalSleepHookNoop,
    autoTimeoutEnabledHook = portalAutoTimeoutDisabled,
  )
  if not recentLogsLockInitialized:
    initLock(globalRecentLogsLock)
    recentLogsLockInitialized = true
  globalRecentLogs = initDeque[JsonNode]()
  globalRecentMetrics = initDeque[JsonNode]()
  globalRecentLogId = 0
  globalFrameConfig = config
  clearAdminSessions()
  globalFrameOS = FrameOS(
    frameConfig: config,
    network: Network(
      status: NetworkStatus.idle,
      hotspotStatus: if hotspotActive: HotspotStatus.enabled else: HotspotStatus.disabled,
      hotspotStartedAt: 0,
    ),
  )
  if sceneOptions.len > 0:
    try:
      setLastPublicSceneId(sceneOptions[0][0])
    except CatchableError:
      discard

proc startRouterServer*(port: int): TestServer =
  let connectionsState = initConnectionsState()
  let adminConnectionsState = initConnectionsState()
  let router = buildRouter(connectionsState, adminConnectionsState)
  result.port = port
  result.server = newServer(buildRouterHandler(router), workerThreads = 1)
  result.listener = result.server.addListener(Port(port), "127.0.0.1")
  createThread(result.thread, serverThread, (result.server, Port(port)))
  sleep(150)

proc stopServer*(testServer: var TestServer) =
  # The router handler is a closure built on this thread; mummy frees it on
  # its serving thread when the server is destroyed. ORC's cycle-candidate
  # roots are per thread, so a closure environment still registered as a
  # root here crashes that thread in unregisterCycle. A collection now
  # clears this thread's registrations (it did so by luck in tests with
  # enough allocation churn; the TLS listener test had too little).
  GC_fullCollect()
  testServer.server.close()
  joinThread(testServer.thread)

type ProbeOutcome* = enum
  ## What one TCP probe against a loopback port actually learned.
  probeConnected   ## the port accepted the connection
  probeRefused     ## the port actively refused it (nothing is listening)
  probeTimedOut    ## no answer inside the deadline — not an answer either way

proc probePort*(port: int, timeoutMs = 1000): ProbeOutcome =
  ## One connect to 127.0.0.1, with every outcome named instead of thrown.
  ##
  ## `std/net` raises `TimeoutError` when the deadline passes, and that is a
  ## plain `CatchableError`, NOT an `OSError` — so the obvious `except OSError`
  ## around a timed `connect` does not catch it, and a single probe that misses
  ## its deadline takes the whole test binary down with an unhandled exception.
  ## That is exactly what a loaded CI runner did to the hotspot-listener suite
  ## (net.nim(2136) connect / TimeoutError) on 2026-09-13. A timed-out probe is
  ## not evidence of anything; callers poll again.
  ##
  ## The socket is closed on every path. `connect` leaves it open when it times
  ## out, and these helpers probe up to a hundred times.
  let probe = newSocket()
  try:
    probe.connect("127.0.0.1", Port(port), timeout = timeoutMs)
    result = probeConnected
  except TimeoutError:
    result = probeTimedOut
  except OSError:
    result = probeRefused
  finally:
    probe.close()

proc waitForPortOpen*(port: int, attempts = 100, timeoutMs = 500): bool =
  ## Polls until something accepts on `port`.
  for _ in 0 ..< attempts:
    if probePort(port, timeoutMs) == probeConnected:
      return true
    sleep(20)
  false

proc waitForPortRefused*(port: int, attempts = 100, timeoutMs = 1000): bool =
  ## Polls until `port` actively refuses, i.e. a listener really is gone.
  ## A probe that times out counts as "not yet" and is retried, never as a
  ## refusal: a socket whose accept loop has not unwound yet can swallow the
  ## SYN, and calling that "closed" would make the assertion pass for the
  ## wrong reason.
  for _ in 0 ..< attempts:
    if probePort(port, timeoutMs) == probeRefused:
      return true
    sleep(20)
  false

proc header*(response: TestResponse, name: string): string =
  response.headers.getOrDefault(name.toLowerAscii(), "")

proc httpRequest*(
    port: int,
    httpMethod: string,
    path: string,
    headers: openArray[(string, string)] = [],
    body = ""
  ): TestResponse =
  var socket = newSocket()
  socket.connect("127.0.0.1", Port(port))

  var requestLines = @[httpMethod & " " & path & " HTTP/1.1"]
  # A caller's own Host header replaces the default (captive-portal tests
  # speak for a phone asking connectivitycheck.gstatic.com).
  var hostGiven = false
  for (name, _) in headers:
    if name.toLowerAscii() == "host":
      hostGiven = true
  if not hostGiven:
    requestLines.add("Host: 127.0.0.1:" & $port)
  requestLines.add("Connection: close")
  for (name, value) in headers:
    requestLines.add(name & ": " & value)
  if body.len > 0:
    requestLines.add("Content-Length: " & $body.len)
  requestLines.add("")
  requestLines.add(body)
  socket.send(requestLines.join("\c\L"))

  var raw = ""
  while true:
    let chunk = socket.recv(4096)
    if chunk.len == 0:
      break
    raw.add(chunk)
  socket.close()

  let headerEnd = raw.find("\c\L\c\L")
  if headerEnd < 0:
    raise newException(IOError, "Invalid HTTP response: missing header separator")

  let responseHead = raw[0 ..< headerEnd]
  result.body = if headerEnd + 4 <= raw.high: raw[(headerEnd + 4) .. raw.high] else: ""
  let lines = responseHead.split("\c\L")
  if lines.len == 0:
    raise newException(IOError, "Invalid HTTP response: missing status line")

  let statusParts = lines[0].split(" ")
  if statusParts.len < 2:
    raise newException(IOError, "Invalid HTTP response status line: " & lines[0])
  result.status = parseInt(statusParts[1])

  result.headers = initTable[string, string]()
  for i in 1 ..< lines.len:
    let line = lines[i]
    let splitAt = line.find(':')
    if splitAt <= 0:
      continue
    let name = line[0 ..< splitAt].strip().toLowerAscii()
    let value = line[(splitAt + 1) .. line.high].strip()
    result.headers[name] = value

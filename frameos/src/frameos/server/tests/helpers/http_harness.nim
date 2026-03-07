import std/[json, net, os, strutils, tables]
import mummy
import mummy/routers

import ../../[routes, state]
import ../../../[channels, scenes, types]
import ../../../portal
from scenes/scenes import sceneOptions

type
  TestServer* = object
    server*: mummy.Server
    port*: int
    thread*: Thread[tuple[server: mummy.Server, port: Port]]

  TestResponse* = object
    status*: int
    headers*: Table[string, string]
    body*: string

proc serverThread(args: tuple[server: mummy.Server, port: Port]) {.thread.} =
  try:
    args.server.serve(args.port, "127.0.0.1")
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
  setPortalHooksForTest(
    runHook = portalRunHookForServerTests,
    sleepHook = portalSleepHookNoop,
    autoTimeoutEnabledHook = portalAutoTimeoutDisabled,
  )
  globalFrameConfig = config
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
  result.server = newServer(router.toHandler(), workerThreads = 1)
  createThread(result.thread, serverThread, (result.server, Port(port)))
  sleep(150)

proc stopServer*(testServer: var TestServer) =
  testServer.server.close()
  joinThread(testServer.thread)

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

  var requestLines = @[
    httpMethod & " " & path & " HTTP/1.1",
    "Host: 127.0.0.1:" & $port,
    "Connection: close",
  ]
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

import json
import locks
import os
import strutils
import deques
import mummy
import mummy/routers
from net import Port
import frameos/types
import frameos/channels
import frameos/config
import ./state
import ./auth
import ./routes
import ./workers
import ./listeners
export workers.httpWorkerThreads
export listeners

proc shouldLogHttpRequest*(path: string): bool =
  if path == "/ws" or path == "/ws/admin":
    return false
  if path.startsWith("/static/"):
    return false
  if path.startsWith("/img/"):
    return false
  if path.startsWith("/api/frames/") and path.endsWith("/logs"):
    return false
  if path.startsWith("/api/frames/") and "/scene_images/" in path:
    return false
  true

proc mummyLogHandler(level: LogLevel, args: varargs[string]) {.gcsafe.} =
  ## mummy's own log lines (a handler exception, a dropped connection, a TLS
  ## handshake) go through the frame logger instead of stdout. Its debug
  ## level is per-connection noise, kept for frames with `debug` on.
  var message = ""
  for arg in args:
    message.add(arg)
  case level:
  of ErrorLevel:
    log(%*{"event": "http:error", "message": message})
  of InfoLevel:
    log(%*{"event": "http:info", "message": message})
  of DebugLevel:
    {.gcsafe.}:
      if globalFrameConfig != nil and globalFrameConfig.debug:
        log(%*{"event": "http:debug", "message": message})

proc makeWebsocketHandler(publicState: ConnectionsState, adminState: ConnectionsState): WebSocketHandler =
  result = proc(websocket: WebSocket, event: WebSocketEvent, message: Message) {.closure, gcsafe.} =
    case event:
    of OpenEvent:
      discard
    of MessageEvent:
      discard
    of ErrorEvent, CloseEvent:
      removeConnection(publicState, websocket)
      removeConnection(adminState, websocket)

proc listenForRenderThread(args: tuple[publicState: ConnectionsState, adminState: ConnectionsState]) {.thread.} =
  while true:
    if hasConnections(args.publicState) or hasConnections(args.adminState):
      let (dataAvailable, _) = serverChannel.tryRecv()
      if dataAvailable:
        if hasConnections(args.publicState):
          sendToAll(args.publicState, "render")
        if hasConnections(args.adminState):
          sendToAll(args.adminState, "render")
      sleep(10)
    else:
      sleep(100)

proc listenForLogThread(connectionsState: ConnectionsState) {.thread.} =
  while true:
    let (success, payload) = logBroadcastChannel.tryRecv()
    if success:
      let uiLog = toUiLog(payload)
      storeUiLog(uiLog)
      if hasConnections(connectionsState):
        sendToAll(connectionsState, $(%*{"event": "new_log", "data": uiLog}))
    else:
      sleep(10)

var renderThread: Thread[tuple[publicState: ConnectionsState, adminState: ConnectionsState]]
var logThread: Thread[ConnectionsState]
# mummy buffers a whole request body in memory before any handler — and so
# before any auth check — runs, and it has no connection cap. At 50 MB a
# handful of concurrent unauthenticated uploads was enough to push a 512 MB
# frame past MemoryMax=90% and into the Restart=always loop. Nothing
# legitimate needs anywhere near this much in one request: asset uploads are
# chunked at 512 KB by the frontend (frontend/src/utils/uploadFileInChunks.ts),
# and the largest JSON payloads are scene definitions.
const MAX_HTTP_BODY_LEN = 8 * 1024 * 1024

proc initServerGlobals(frameOS: FrameOS) =
  globalFrameOS = frameOS
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner
  setGlobalAdminSessionSalt(getOrCreateAdminSessionSalt(getConfigFilename()))
  clearAdminSessions()
  initLock(globalRecentLogsLock)
  globalRecentLogs = initDeque[JsonNode]()
  globalRecentMetrics = initDeque[JsonNode]()
  globalRecentLogId = 0

proc newServer*(frameOS: FrameOS): types.Server =
  initServerGlobals(frameOS)

  let connectionsState = initConnectionsState()
  let adminConnectionsState = initConnectionsState()
  globalAdminConnectionsState = adminConnectionsState
  let router = buildRouter(connectionsState, adminConnectionsState)
  let routerHandler = buildRouterHandler(router)
  let loggingHandler = proc(request: Request) {.gcsafe.} =
    if shouldLogHttpRequest(request.path):
      log(%*{"event": "http", "method": request.httpMethod, "path": request.path})
    routerHandler(request)
  let workerThreads = httpWorkerThreads()
  let mummyServer = mummy.newServer(
    loggingHandler,
    makeWebsocketHandler(connectionsState, adminConnectionsState),
    logHandler = mummyLogHandler,
    workerThreads = workerThreads,
    maxBodyLen = MAX_HTTP_BODY_LEN
  )

  result = types.Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    mummy: mummyServer,
    httpWorkerThreads: workerThreads,
    connectionsState: connectionsState,
  )

proc addTlsListener(self: types.Server, spec: ListenerSpec): bool =
  ## The HTTPS listener is best effort: a certificate the runtime cannot
  ## load or a port it cannot bind is logged and the frame stays reachable
  ## over plain HTTP, exactly as when the Caddy proxy failed to start.
  when defined(ssl):
    var tls: TlsConfig
    try:
      tls = newTlsConfig(self.frameConfig.httpsProxy.serverCert, self.frameConfig.httpsProxy.serverKey)
    except MummyError as e:
      log(%*{
        "event": "tls:config_error",
        "message": "Could not load the frame's TLS certificate or key, HTTPS stays off",
        "error": e.msg,
      })
      return false
    try:
      discard self.mummy.addListener(Port(spec.port), spec.address, tls)
    except MummyError as e:
      log(%*{
        "event": "tls:start_error",
        "message": "Could not open the HTTPS listener",
        "error": e.msg,
        "port": spec.port,
        "address": spec.address,
      })
      return false
    log(%*{
      "event": "tls:start",
      "message": "Serving HTTPS",
      "port": spec.port,
      "address": spec.address,
    })
    true
  else:
    log(%*{
      "event": "tls:start_error",
      "message": "This build has no OpenSSL support, HTTPS stays off",
      "port": spec.port,
    })
    false

proc startServer*(self: types.Server) =
  let specs = planListeners(self.frameConfig)
  log(%*{
    "event": "http:start",
    "message": "Starting web server",
    "workerThreads": self.httpWorkerThreads,
    "listeners": %*(specs),
  })
  # mummy.serve blocks this thread, so run render notifications in a background thread.
  createThread(renderThread, listenForRenderThread, (self.connectionsState, globalAdminConnectionsState))
  createThread(logThread, listenForLogThread, globalAdminConnectionsState)

  if httpsEnabled(self.frameConfig) and not hasTlsMaterial(self.frameConfig):
    log(%*{
      "event": "tls:default_cert",
      "message": "No TLS certificate provided, can't enable HTTPS",
    })

  for spec in specs:
    if spec.tls:
      discard self.addTlsListener(spec)
    else:
      # The plain listener is not optional: failing to bind it is fatal, as
      # it always was, and systemd restarts the runtime.
      discard self.mummy.addListener(Port(spec.port), spec.address)
  self.mummy.serve()

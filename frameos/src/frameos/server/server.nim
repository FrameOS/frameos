import json
import locks
import os
import strutils
import mummy
import mummy/routers
from net import Port
import frameos/types
import frameos/channels
import frameos/config
import ./state
import ./auth
import ./routes

proc shouldLogHttpRequest*(path: string): bool =
  if path == "/ws" or path == "/ws/admin":
    return false
  if path.startsWith("/static/"):
    return false
  if path.startsWith("/api/frames/") and path.endsWith("/logs"):
    return false
  if path.startsWith("/api/frames/") and "/scene_images/" in path:
    return false
  true

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
const MAX_HTTP_BODY_LEN = 50 * 1024 * 1024

proc initServerGlobals(frameOS: FrameOS) =
  globalFrameOS = frameOS
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner
  setGlobalAdminSessionSalt(getOrCreateAdminSessionSalt(getConfigFilename()))
  clearAdminSessions()
  initLock(globalRecentLogsLock)
  globalRecentLogs = @[]
  globalRecentLogId = 0

proc newServer*(frameOS: FrameOS): types.Server =
  initServerGlobals(frameOS)

  let connectionsState = initConnectionsState()
  let adminConnectionsState = initConnectionsState()
  globalAdminConnectionsState = adminConnectionsState
  let router = buildRouter(connectionsState, adminConnectionsState)
  let routerHandler = router.toHandler()
  let loggingHandler = proc(request: Request) {.gcsafe.} =
    if shouldLogHttpRequest(request.path):
      log(%*{"event": "http", "method": request.httpMethod, "path": request.path})
    routerHandler(request)
  let mummyServer = mummy.newServer(
    loggingHandler,
    makeWebsocketHandler(connectionsState, adminConnectionsState),
    maxBodyLen = MAX_HTTP_BODY_LEN
  )

  result = types.Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    mummy: mummyServer,
    connectionsState: connectionsState,
  )

proc serverPort*(frameConfig: FrameConfig): int =
  if frameConfig.framePort == 0: 8787 else: frameConfig.framePort

proc serverBindAddress*(frameConfig: FrameConfig): string =
  if frameConfig.httpsProxy.enable and frameConfig.httpsProxy.exposeOnlyPort: "127.0.0.1" else: "0.0.0.0"

proc startServer*(self: types.Server) =
  log(%*{"event": "http:start", "message": "Starting web server"})
  # mummy.serve blocks this thread, so run render notifications in a background thread.
  createThread(renderThread, listenForRenderThread, (self.connectionsState, globalAdminConnectionsState))
  createThread(logThread, listenForLogThread, globalAdminConnectionsState)

  let port = serverPort(self.frameConfig).Port
  let bindAddr = serverBindAddress(self.frameConfig)
  self.mummy.serve(port = port, address = bindAddr)

import json
import locks
import os
import mummy
import mummy/routers
from net import Port
import frameos/types
import frameos/channels
import frameos/config
import ./state
import ./auth
import ./routes

proc makeWebsocketHandler(publicState: ConnectionsState, adminState: ConnectionsState): WebSocketHandler =
  result = proc(websocket: WebSocket, event: WebSocketEvent, message: Message) {.closure, gcsafe.} =
    case event:
    of OpenEvent:
      log(%*{"event": "websocket:connect"})
    of MessageEvent:
      log(%*{"event": "websocket:message", "message": message.data})
    of ErrorEvent, CloseEvent:
      log(%*{"event": "websocket:disconnect"})
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
        log(%*{"event": "websocket:send", "message": "render"})
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

proc initServerGlobals(frameOS: FrameOS) =
  globalFrameOS = frameOS
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner
  globalAdminSessionSalt = getOrCreateAdminSessionSalt(getConfigFilename())
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
    log(%*{"event": "http", "method": request.httpMethod, "path": request.path})
    routerHandler(request)
  let mummyServer = mummy.newServer(loggingHandler, makeWebsocketHandler(connectionsState, adminConnectionsState))

  result = types.Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    mummy: mummyServer,
    connectionsState: connectionsState,
  )

proc startServer*(self: types.Server) =
  log(%*{"event": "http:start", "message": "Starting web server"})
  # mummy.serve blocks this thread, so run render notifications in a background thread.
  createThread(renderThread, listenForRenderThread, (self.connectionsState, globalAdminConnectionsState))
  createThread(logThread, listenForLogThread, globalAdminConnectionsState)

  let port = (if self.frameConfig.framePort == 0: 8787 else: self.frameConfig.framePort).Port
  let bindAddr = if self.frameConfig.httpsProxy.enable and self.frameConfig.httpsProxy.exposeOnlyPort: "127.0.0.1" else: "0.0.0.0"
  self.mummy.serve(port = port, address = bindAddr)

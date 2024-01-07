# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.
import json
import pixie
import assets/web as webAssets
import asyncdispatch
import jester
import locks
import ws, ws/jester_extra

from net import Port
import options
import strutils
from frameos/types import FrameOS, FrameConfig, Logger, Server, RunnerControl
from frameos/runner import lastRender, triggerRender, getLastImage

var globalLogger: Logger
var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl
let indexHtml = webAssets.getAsset("assets/web/index.html")

var connections = newSeq[WebSocket]()
var connectionsLock: Lock

initLock(connectionsLock)

proc sendToAll(message: string) {.async.} =
  withLock connectionsLock:
    for ws in connections:
      if ws.readyState == Open:
        asyncCheck ws.send(message)


proc match(request: Request): Future[ResponseData] {.async.} =
  {.cast(gcsafe).}:
    block route:
      case request.pathInfo
      of "/":
        let scalingMode = case globalFrameConfig.scalingMode:
          of "cover", "center":
            globalFrameConfig.scalingMode
          of "stretch":
            "100% 100%"
          else:
            "contain"
        resp Http200, indexHtml.replace("/*$scalingMode*/contain", scalingMode)
      of "/ws":
        var ws = await newWebSocket(request)
        try:
          globalLogger.log(%*{"event": "websocket", "connect": ws.key})
          withLock connectionsLock:
            connections.add ws
          while ws.readyState == Open:
            let packet = await ws.receiveStrPacket()
            globalLogger.log(%*{"event": "websocket", "message": packet})
            # TODO: handle incoming messages
            # TODO: accept render events, but debounced?
            # TODO: send render events
            await sendToAll(packet)
        except WebSocketError:
          globalLogger.log(%*{"event": "websocket", "disconnect": ws.key, "reason": getCurrentExceptionMsg()})
          withLock connectionsLock:
            let index = connections.find(ws)
            if index >= 0:
              connections.del(index)
      of "/event/render":
        globalLogger.log(%*{"event": "http", "path": request.pathInfo})
        globalRunner.triggerRender()
        resp Http200, {"Content-Type": "application/json"}, $(%*{
            "status": "ok"})
      of "/event/turnOn":
        globalLogger.log(%*{"event": "http", "path": request.pathInfo})
        globalRunner.sendEvent("turnOn", %*{})
        resp Http200, {"Content-Type": "application/json"}, $(%*{
            "status": "ok"})
      of "/event/turnOff":
        globalLogger.log(%*{"event": "http", "path": request.pathInfo})
        globalRunner.sendEvent("turnOff", %*{})
        resp Http200, {"Content-Type": "application/json"}, $(%*{
            "status": "ok"})
      of "/image":
        globalLogger.log(%*{"event": "http", "path": request.pathInfo})
        resp Http200, {"Content-Type": "image/png"}, globalRunner.getLastImage().encodeImage(PngFormat)
      else:
        resp Http404, "Not found!"


proc newServer*(frameOS: FrameOS): Server =
  globalFrameConfig = frameOS.frameConfig
  globalLogger = frameOS.logger
  globalRunner = frameOS.runner

  let port = (frameOS.frameConfig.framePort or 8787).Port
  let settings = newSettings(port = port)
  var jester = initJester(matcher = match.MatchProc, settings = settings)

  result = Server(
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
    runner: frameOS.runner,
    jester: jester,
  )

proc startServer*(self: Server) {.async.} =
  self.logger.log(%*{"event": "http:start",
      "message": "Starting web server"})
  self.jester.serve() # blocks forever

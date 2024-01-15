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
import drivers/drivers as drivers
import frameos/types
import frameos/channels
import frameos/utils/image
from frameos/runner import getLastPng, triggerRender

var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl
let indexHtml = webAssets.getAsset("assets/web/index.html")

var connectionsLock: Lock
var connections {.guard: connectionsLock.} = newSeq[WebSocket]()

proc sendToAll(message: string) {.async.} =
  withLock connectionsLock:
    for connection in connections:
      if connection.readyState == Open:
        asyncCheck connection.send(message)

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
          log(%*{"event": "websocket:connect", "key": ws.key})
          withLock connectionsLock:
            connections.add ws
          while ws.readyState == Open:
            let packet = await ws.receiveStrPacket()
            log(%*{"event": "websocket:message", "message": packet})
            # TODO: accept (debounced) render requests?
        except WebSocketError:
          log(%*{"event": "websocket:disconnect", "key": ws.key, "reason": getCurrentExceptionMsg()})
          withLock connectionsLock:
            let index = connections.find(ws)
            if index >= 0:
              connections.delete(index)
      of "/event/render":
        log(%*{"event": "http", "path": request.pathInfo})
        globalRunner.triggerRender()
        resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
      of "/event/turnOn":
        log(%*{"event": "http", "path": request.pathInfo})
        globalRunner.sendEvent("turnOn", %*{})
        resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
      of "/event/turnOff":
        log(%*{"event": "http", "path": request.pathInfo})
        globalRunner.sendEvent("turnOff", %*{})
        resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
      of "/image":
        log(%*{"event": "http", "path": request.pathInfo})
        let image = drivers.toPng(360 - globalFrameConfig.rotate)
        if image != "":
          resp Http200, {"Content-Type": "image/png"}, image
        else:
          resp Http200, {"Content-Type": "image/png"}, getLastPng()
      else:
        resp Http404, "Not found!"

proc listenForRender*() {.async.} =
  var hasConnections = false
  while true:
    withLock connectionsLock:
      hasConnections = connections.len > 0
    if hasConnections:
      let (dataAvailable, _) = serverChannel.tryRecv()
      if dataAvailable:
        asyncCheck sendToAll("render")
        log(%*{"event": "websocket:send", "message": "render"})
      await sleepAsync(0.1)
    else:
      await sleepAsync(2)

proc newServer*(frameOS: FrameOS): Server =
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner

  let port = (frameOS.frameConfig.framePort or 8787).Port
  let settings = newSettings(port = port)
  var jester = initJester(matcher = match.MatchProc, settings = settings)

  result = Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    jester: jester,
  )

proc startServer*(self: Server) {.async.} =
  log(%*{"event": "http:start", "message": "Starting web server"})
  asyncCheck listenForRender()
  self.jester.serve() # blocks forever

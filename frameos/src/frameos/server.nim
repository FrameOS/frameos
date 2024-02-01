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
import strutils, strformat
import drivers/drivers as drivers
import frameos/types
import frameos/channels
import frameos/config
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

router myrouter:
  get "/":
    {.gcsafe.}: # We're only reading static assets. It's fine.
      let scalingMode = case globalFrameConfig.scalingMode:
        of "cover", "center":
          globalFrameConfig.scalingMode
        of "stretch":
          "100% 100%"
        else:
          "contain"
      resp Http200, indexHtml.replace("/*$scalingMode*/contain", scalingMode)
  get "/ws":
    {.gcsafe.}: # We're only modifying globals via locks. It's fine.
      var ws = await newWebSocket(request)
      try:
        log(%*{"event": "websocket:connect", "key": ws.key})
        withLock connectionsLock:
          connections.add ws
        while ws.readyState == Open:
          let packet = await ws.receiveStrPacket()
          log(%*{"event": "websocket:message", "message": packet})
          # TODO: accept events?
      except WebSocketError:
        log(%*{"event": "websocket:disconnect", "key": ws.key, "reason": getCurrentExceptionMsg()})
        withLock connectionsLock:
          let index = connections.find(ws)
          if index >= 0:
            connections.delete(index)
  post "/event/@name":
    log(%*{"event": "http", "post": request.pathInfo})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(@"name", payload)
    resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
  get "/image":
    log(%*{"event": "http", "get": request.pathInfo})
    {.gcsafe.}: # We're reading immutable globals and png data via a lock. It's fine.
      try:
        let image = drivers.toPng(360 - globalFrameConfig.rotate)
        if image != "":
          resp Http200, {"Content-Type": "image/png"}, image
        else:
          raise newException(Exception, "No image available")
      except Exception:
        try:
          resp Http200, {"Content-Type": "image/png"}, getLastPng()
        except Exception as e:
          resp Http200, {"Content-Type": "image/png"}, renderError(globalFrameConfig.renderWidth(),
            globalFrameConfig.renderHeight(), &"Error: {$e.msg}\n{$e.getStackTrace()}").encodeImage(PngFormat)
  get "/c":
    var html = "<html><meta name='viewport' content='width=device-width, initial-scale=1.0'><body><h1>Control</h1>"
    html.add("<script>function postRender() { fetch('/event/render', {method:'POST',headers:{'Content-Type': 'application/json'},body:JSON.stringify({})}) }</script>")
    html.add("<form onSubmit='postRender(); return false'><input type='submit' value='Render'></form>")
    html.add("<script>function postSetSceneState() { var data={render:true,state:{message:document.getElementById('message').value, background:document.getElementById('background').value}};fetch('/event/setSceneState', {method:'POST',headers:{'Content-Type': 'application/json'},body:JSON.stringify(data)}); document.getElementById('setSceneState').value = 'Now wait a while...'; }</script>")
    html.add("<form onSubmit='postSetSceneState(); return false'><textarea id='message' placeholder='message'></textarea><br/><input type='text' id='background' value='' placeholder='background, one word'/><br/><input type='submit' id='setSceneState' value='Set Scene State'></form>")
    resp Http200, {"Content-Type": "text/html"}, html

  error Http404:
    log(%*{"event": "404", "path": request.pathInfo})
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
  var jester = initJester(myrouter, settings)

  result = Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    jester: jester,
  )

proc startServer*(self: Server) {.async.} =
  log(%*{"event": "http:start", "message": "Starting web server"})
  asyncCheck listenForRender()
  self.jester.serve() # blocks forever

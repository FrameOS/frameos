# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.
import json
import pixie
import assets/web as webAssets
import asyncdispatch
import jester
import locks
import ws, ws/jester_extra
import strformat
import options
import strutils
import drivers/drivers as drivers
import frameos/types
import frameos/channels
import frameos/config
import frameos/utils/image
from net import Port
from frameos/runner import getLastPng, getLastPublicState, getPublicStateFields, triggerRender

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

proc h(message: string): string =
  message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#039;")

proc s(message: string): string =
  message.replace("'", "\\'").replace("\n", "\\n")

const AUTH_HEADER = "authorization"
const AUTH_TYPE = "Bearer"

type
  AccessType = enum
    Read
    Write

router myrouter:
  proc hasAccess*(request: Request, accessType: AccessType): bool =
    {.gcsafe.}:
      let access = globalFrameConfig.frameAccess
      if access == "public" or (access == "protected" and accessType == Read):
        return true
      let accessKey = globalFrameConfig.frameAccessKey
      if accessKey == "":
        return false
      if request.reqMethod() == HttpPost:
        return contains(request.headers.table, AUTH_HEADER) and request.headers[AUTH_HEADER] == AUTH_TYPE & " " & accessKey
      else:
        let paramsTable = request.params()
        return contains(paramsTable, "k") and paramsTable["k"] == accessKey
  get "/":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
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
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
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
  get "/image":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
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
  post "/event/@name":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "post": request.pathInfo})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(@"name", payload)
    resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
  get "/state":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    resp Http200, {"Content-Type": "application/json"}, $getLastPublicState()
  get "/c":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    var fieldsHtml = ""
    var fieldsSubmitHtml = ""
    let fields = getPublicStateFields()
    let values = getLastPublicState()
    for field in fields:
      let key = field.name
      let label = if field.label != "": field.label else: key
      let placeholder = field.placeholder
      let fieldType = field.fieldType
      let value = if values.hasKey(key): values{key} else: %*""
      var stringValue = value.getStr()

      if fieldsSubmitHtml != "":
        fieldsSubmitHtml.add(", ")
      if fieldType == "integer":
        stringValue = $value.getInt()
        fieldsSubmitHtml.add(fmt"'{s($key)}': parseInt(document.getElementById('{s($key)}').value)")
      elif fieldType == "float":
        stringValue = $value.getFloat()
        fieldsSubmitHtml.add(fmt"'{s($key)}': parseFloat(document.getElementById('{s($key)}').value)")
      elif fieldType == "boolean":
        stringValue = $value.getBool()
        fieldsSubmitHtml.add(fmt"'{s($key)}': document.getElementById('{s($key)}').value === 'true'")
      else:
        fieldsSubmitHtml.add(fmt"'{s($key)}': document.getElementById('{s($key)}').value")

      fieldsHtml.add(fmt"<label for='{h($key)}'>{h(label)}</label><br/>")
      if fieldType == "text":
        fieldsHtml.add(fmt"<textarea id='{h($key)}' placeholder='{h(placeholder)}'>{h(stringValue)}</textarea><br/><br/>")
      elif fieldType == "select":
        fieldsHtml.add(fmt"<select id='{h($key)}' placeholder='{h(placeholder)}'>")
        for option in field.options:
          let selected = if option == stringValue: " selected" else: ""
          fieldsHtml.add(fmt"<option value='{h($option)}'{selected}>{h($option)}</option>")
        fieldsHtml.add("</select><br/><br/>")
      else:
        fieldsHtml.add(fmt"<input type='text' id='{h($key)}' placeholder='{h(placeholder)}' value='{h(stringValue)}' /><br/><br/>")

    fieldsHtml.add("<input type='submit' id='setSceneState' value='Set Scene State'>")
    {.gcsafe.}: # We're only reading static assets. It's fine.
      let controlHtml = webAssets.getAsset("assets/web/control.html").
        replace("/*$$fieldsHtml$$*/", fieldsHtml).
        replace("/*$$fieldsSubmitHtml$$*/", fieldsSubmitHtml).
        replace("Frame Control", if globalFrameConfig.name != "": h(globalFrameConfig.name) else: "Frame Control")
      resp Http200, controlHtml

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

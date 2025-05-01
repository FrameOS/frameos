import json
import pixie
import assets/web as webAssets
import asyncdispatch
import httpclient
import threadpool
import os
import jester
import locks
import ws, ws/jester_extra
import strformat
import options
import strutils
import drivers/drivers as drivers
import frameos/apps
import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/font
import frameos/portal as netportal
from net import Port
from frameos/scenes import getLastImagePng, getLastPublicState, getAllPublicStates
from scenes/scenes import sceneOptions

var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl
let indexHtml = webAssets.getAsset("assets/compiled/web/index.html")

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
    if netportal.active:
      resp Http200, netportal.setupHtml()
    elif not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    else:
      {.gcsafe.}: # We're only printing a static variable.
        let scalingMode = case globalFrameConfig.scalingMode:
          of "cover", "center": globalFrameConfig.scalingMode
          of "stretch": "100% 100%"
          else: "contain"
        resp Http200, indexHtml.replace("/*$scalingMode*/contain", scalingMode)
  post "/setup":
    if not netportal.active:
      resp Http400, "Not in setup mode"
    {.gcsafe.}:
      let params = request.params()
      spawn netportal.connectToWifi(
        params["ssid"],
        params.getOrDefault("password", ""),
        globalFrameConfig
      )
    resp Http200, netportal.confirmHtml()
  # Captive portal URLs...
  get "/generate_204":
    resp Http302, {"Location": "/"}, ""
  get "/gen_204":
    resp Http302, {"Location": "/"}, ""
  get "/hotspot-detect.html":
    resp Http302, {"Location": "/"}, ""
  get "/hotspot-detect":
    resp Http302, {"Location": "/"}, ""
  get "/ncsi.txt":
    resp Http302, {"Location": "/"}, ""
  get "/connecttest.txt":
    resp Http302, {"Location": "/"}, ""
  get "/library/test/success.html":
    resp Http302, {"Location": "/"}, ""
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
      let (sceneId, _, _) = getLastPublicState()
      let headers = {
        "Content-Type": "image/png",
        "Content-Disposition": &"inline; filename=\"{sceneId}.png\"",
        "X-Scene-Id": $sceneId,
        "Access-Control-Expose-Headers": "X-Scene-Id"
      }
      try:
        let image = drivers.toPng(360 - globalFrameConfig.rotate)
        if image != "":
          resp Http200, headers, image
        else:
          raise newException(Exception, "No image available")
      except Exception:
        try:
          resp Http200, headers, getLastImagePng()
        except Exception as e:
          resp Http200, headers, renderError(globalFrameConfig.renderWidth(),
            globalFrameConfig.renderHeight(), &"Error: {$e.msg}\n{$e.getStackTrace()}").encodeImage(PngFormat)
  post "/event/@name":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "post": request.pathInfo})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(@"name", payload)
    resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
  get "/states":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "get": request.pathInfo})
    {.gcsafe.}: # It's a copy of the state, so it's fine.
      let (sceneId, states) = getAllPublicStates()
      resp Http200, {"Content-Type": "application/json"}, $(%*{"sceneId": $sceneId, "states": states})
  get "/state":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "get": request.pathInfo})
    {.gcsafe.}: # It's a copy of the state, so it's fine.
      let (sceneId, state, _) = getLastPublicState()
      resp Http200, {"Content-Type": "application/json"}, $(%*{"sceneId": $sceneId, "state": state})
  get "/c":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    var fieldsHtml = ""
    var fieldsSubmitHtml = ""
    let (currentSceneId, values, fields) = getLastPublicState()
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
        fieldsHtml.add(fmt"<textarea id='{h($key)}' placeholder='{h(placeholder)}' rows=5>{h(stringValue)}</textarea><br/><br/>")
      elif fieldType == "select" or fieldType == "boolean" or fieldType == "font":
        fieldsHtml.add(fmt"<select id='{h($key)}' placeholder='{h(placeholder)}'>")
        {.gcsafe.}: # We're reading an immutable global (assetsPath) via a lock.
          let options = if fieldType == "boolean": @["true", "false"]
                        elif fieldType == "font": getAvailableFonts(globalFrameConfig.assetsPath)
                        else: field.options
        for option in options:
          let selected = if option == stringValue: " selected" else: ""
          fieldsHtml.add(fmt"<option value='{h($option)}'{selected}>{h($option)}</option>")
        fieldsHtml.add("</select><br/><br/>")
      else:
        fieldsHtml.add(fmt"<input type='text' id='{h($key)}' placeholder='{h(placeholder)}' value='{h(stringValue)}' /><br/><br/>")

    var sceneOptionsHtml = ""
    for (sceneId, sceneName) in sceneOptions:
      let selected = if sceneId == currentSceneId: " selected" else: ""
      sceneOptionsHtml.add(fmt"<option value='{h(sceneId.string)}'{selected}>{h(sceneName)}</option>")

    fieldsHtml.add("<input type='submit' id='setSceneState' value='Set Scene State'>")
    {.gcsafe.}: # We're only reading static assets. It's fine.
      let controlHtml = webAssets.getAsset("assets/compiled/web/control.html").
        replace("/*$$fieldsHtml$$*/", fieldsHtml).
        replace("/*$$fieldsSubmitHtml$$*/", fieldsSubmitHtml).
        replace("/*$$sceneOptionsHtml$$*/", sceneOptionsHtml).
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
      await sleepAsync(10)
    else:
      await sleepAsync(100)

proc newServer*(frameOS: FrameOS): Server =
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner

  let port = (if frameOS.frameConfig.framePort == 0: 8787 else: frameOS.frameConfig.framePort).Port
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

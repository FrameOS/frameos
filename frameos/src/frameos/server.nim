import json
import pixie
import times
import std/os
import assets/web as webAssets
import httpcore
import threadpool
import locks
import strformat
import options
import strutils
import tables
import algorithm
import mummy
import mummy/routers
import drivers/drivers as drivers
import frameos/apps
import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/font
import frameos/config
import frameos/portal as netportal
from net import Port
from frameos/scenes import getLastImagePng, getLastPublicState, getAllPublicStates, getUploadedScenePayload,
    getDynamicSceneOptions
from scenes/scenes import sceneOptions

var globalFrameOS: FrameOS
var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl
let indexHtml = webAssets.getAsset("assets/compiled/web/index.html")

proc initConnectionsState(): ConnectionsState =
  new(result)
  initLock(result.lock)
  result.items = @[]

proc sendToAll(state: ConnectionsState, message: string) {.gcsafe.} =
  withLock state.lock:
    for connection in state.items:
      connection.send(message)

proc addConnection(state: ConnectionsState, websocket: WebSocket) {.gcsafe.} =
  withLock state.lock:
    state.items.add(websocket)

proc removeConnection(state: ConnectionsState, websocket: WebSocket) {.gcsafe.} =
  withLock state.lock:
    let index = state.items.find(websocket)
    if index >= 0:
      state.items.delete(index)

proc hasConnections(state: ConnectionsState): bool {.gcsafe.} =
  withLock state.lock:
    result = state.items.len > 0

proc h(message: string): string =
  message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#039;")

proc s(message: string): string =
  message.replace("'", "\\'").replace("\n", "\\n")

proc shouldReturnNotModified*(headers: httpcore.HttpHeaders, lastUpdate: float): bool {.gcsafe.} =
  if lastUpdate <= 0.0:
    return false
  let ifModifiedSince = seq[string](headers.getOrDefault("if-modified-since")).join(", ")
  if ifModifiedSince == "":
    return false
  try:
    let ifModifiedTime = parse(ifModifiedSince, "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    return int64(lastUpdate) <= ifModifiedTime.toTime().toUnix()
  except CatchableError:
    return false

proc shouldReturnNotModified(headers: mummy.HttpHeaders, lastUpdate: float): bool {.gcsafe.} =
  if lastUpdate <= 0.0:
    return false
  var values: seq[string]
  for (name, value) in headers:
    if cmpIgnoreCase(name, "if-modified-since") == 0:
      values.add(value)
  let ifModifiedSince = values.join(", ")
  if ifModifiedSince == "":
    return false
  try:
    let ifModifiedTime = parse(ifModifiedSince, "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    return int64(lastUpdate) <= ifModifiedTime.toTime().toUnix()
  except CatchableError:
    return false

const AUTH_HEADER = "authorization"
const AUTH_TYPE = "Bearer"

type
  AccessType = enum
    Read
    Write

proc respond(request: Request; statusCode: httpcore.HttpCode;
    headers: sink mummy.HttpHeaders = emptyHttpHeaders(); body: sink string = "") =
  mummy.respond(request, int(statusCode), headers, body)

proc hasAccess(request: Request, accessType: AccessType): bool =
  {.gcsafe.}:
    let access = globalFrameConfig.frameAccess
    if access == "public" or (access == "protected" and accessType == Read):
      return true
    let accessKey = globalFrameConfig.frameAccessKey
    if accessKey == "":
      return false
    if request.httpMethod == "POST":
      return request.headers.contains(AUTH_HEADER) and request.headers[AUTH_HEADER] == AUTH_TYPE & " " & accessKey
    return request.queryParams.contains("k") and request.queryParams["k"] == accessKey

proc parseUrlEncoded(body: string): Table[string, string] =
  for pair in body.split('&'):
    if pair == "":
      continue
    let kv = pair.split('=', 1)
    let key = decodeQueryComponent(kv[0])
    let value = if kv.len > 1: decodeQueryComponent(kv[1]) else: ""
    result[key] = value

proc jsonResponse(request: Request, statusCode: httpcore.HttpCode, payload: JsonNode) =
  var headers: mummy.HttpHeaders
  headers["Content-Type"] = "application/json"
  request.respond(int(statusCode), headers, $payload)

proc makeWebsocketHandler(state: ConnectionsState): WebSocketHandler =
  result = proc(websocket: WebSocket, event: WebSocketEvent, message: Message) {.closure, gcsafe.} =
    case event:
    of OpenEvent:
      log(%*{"event": "websocket:connect"})
    of MessageEvent:
      log(%*{"event": "websocket:message", "message": message.data})
    of ErrorEvent, CloseEvent:
      log(%*{"event": "websocket:disconnect"})
      removeConnection(state, websocket)

proc buildRouter(connectionsState: ConnectionsState): Router =
  result.get("/", proc(request: Request) =
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.path})
        request.respond(Http200, body = netportal.setupHtml(globalFrameOS))
      elif not hasAccess(request, Read):
        request.respond(Http401, body = "Unauthorized")
      else:
        let scalingMode = case globalFrameConfig.scalingMode:
          of "cover", "center": globalFrameConfig.scalingMode
          of "stretch": "100% 100%"
          else: "contain"
        request.respond(Http200, body = indexHtml.replace("/*$scalingMode*/contain", scalingMode))
  )

  result.post("/setup", proc(request: Request) =
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        request.respond(Http400, body = "Not in setup mode")
        return
      let params = parseUrlEncoded(request.body)
      log(%*{"event": "portal:http", "post": request.path, "params": params})
      if not params.hasKey("ssid"):
        request.respond(Http400, body = "Missing ssid")
        return
      spawn netportal.connectToWifi(
        globalFrameOS,
        params["ssid"],
        params.getOrDefault("password", ""),
        params.getOrDefault("serverHost", globalFrameOS.frameConfig.serverHost),
        params.getOrDefault("serverPort", $globalFrameOS.frameConfig.serverPort),
      )
      request.respond(Http200, body = netportal.confirmHtml())
  )

  result.get("/ping", proc(request: Request) =
    request.respond(Http200, body = "pong")
  )

  result.get("/setup", proc(request: Request) =
    var headers: mummy.HttpHeaders
    headers["Location"] = "/"
    request.respond(Http302, headers)
  )

  result.get("/wifi", proc(request: Request) =
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        request.respond(Http400, body = "Not in setup mode")
      else:
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        let nets = netportal.availableNetworks(globalFrameOS)
        request.respond(Http200, headers, $(%*{"networks": nets}))
  )

  result.get("/ws", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      let websocket = request.upgradeToWebSocket()
      addConnection(connectionsState, websocket)
    except CatchableError:
      request.respond(Http500, body = "WebSocket upgrade failed")
  )

  result.get("/image", proc(request: Request) =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (sceneId, _, _, lastUpdate) = getLastPublicState()
      if shouldReturnNotModified(request.headers, lastUpdate):
        var headers: mummy.HttpHeaders
        headers["X-Scene-Id"] = $sceneId
        headers["Access-Control-Expose-Headers"] = "X-Scene-Id"
        request.respond(Http304, headers)
        return
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "image/png"
      headers["Content-Disposition"] = &"inline; filename=\"{sceneId}.png\""
      headers["X-Scene-Id"] = $sceneId
      headers["Access-Control-Expose-Headers"] = "X-Scene-Id"
      if lastUpdate > 0.0:
        let lastModified = format(fromUnix(int64(lastUpdate)), "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
        headers["Last-Modified"] = lastModified
      try:
        let image = drivers.toPng(360 - globalFrameConfig.rotate)
        if image != "":
          request.respond(Http200, headers, image)
        else:
          raise newException(Exception, "No image available")
      except Exception:
        try:
          request.respond(Http200, headers, getLastImagePng())
        except Exception as e:
          request.respond(Http200, headers, renderError(globalFrameConfig.renderWidth(),
            globalFrameConfig.renderHeight(), &"Error: {$e.msg}\n{$e.getStackTrace()}").encodeImage(PngFormat))
  )

  result.post("/event/@name", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(request.pathParams["name"], payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  result.post("/uploadScenes", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  result.post("/reload", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      {.gcsafe.}:
        let newConfig = loadConfig()
        updateFrameConfigFrom(globalFrameOS.frameConfig, newConfig)
      sendEvent("reload", %*{})
      jsonResponse(request, Http200, %*{"status": "ok"})
    except CatchableError as e:
      log(%*{"event": "reload:error", "error": e.msg})
      jsonResponse(request, Http500, %*{"status": "error", "error": e.msg})
  )

  result.get("/states", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (sceneId, states) = getAllPublicStates()
      jsonResponse(request, Http200, %*{"sceneId": $sceneId, "states": states})
  )

  result.get("/getUploadedScenes", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let payload = %*{"scenes": getUploadedScenePayload()}
      jsonResponse(request, Http200, payload)
  )

  result.get("/state", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (sceneId, state, _, _) = getLastPublicState()
      jsonResponse(request, Http200, %*{"sceneId": $sceneId, "state": state})
  )

  result.get("/c", proc(request: Request) =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    var fieldsHtml = ""
    var fieldsSubmitHtml = ""
    let (currentSceneId, values, fields, _) = getLastPublicState()
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
        {.gcsafe.}:
          let options = if fieldType == "boolean": @[
            "true", "false"
          ] elif fieldType == "font":
            getAvailableFonts(globalFrameConfig.assetsPath)
          else:
            field.options
        for option in options:
          let selected = if option == stringValue: " selected" else: ""
          fieldsHtml.add(fmt"<option value='{h($option)}'{selected}>{h($option)}</option>")
        fieldsHtml.add("</select><br/><br/>")
      else:
        fieldsHtml.add(fmt"<input type='text' id='{h($key)}' placeholder='{h(placeholder)}' value='{h(stringValue)}' /><br/><br/>")

    var sceneOptionsHtml = ""
    var allSceneOptions: seq[tuple[id: SceneId, name: string]]
    var seenSceneIds = initTable[string, bool]()

    proc addSceneOption(sceneId: SceneId, sceneName: string) =
      let sceneIdString = sceneId.string
      if seenSceneIds.hasKey(sceneIdString):
        return
      seenSceneIds[sceneIdString] = true
      allSceneOptions.add((id: sceneId, name: sceneName))

    for (sceneId, sceneName) in sceneOptions:
      addSceneOption(sceneId, sceneName)
    var dynamicSceneOptions: seq[tuple[id: SceneId, name: string]]
    {.gcsafe.}:
      dynamicSceneOptions = getDynamicSceneOptions()
    for (sceneId, sceneName) in dynamicSceneOptions:
      addSceneOption(sceneId, sceneName)

    allSceneOptions.sort(proc(a, b: tuple[id: SceneId, name: string]): int =
      result = cmpIgnoreCase(a.name, b.name)
      if result == 0:
        result = cmp(a.id.string, b.id.string)
    )

    for sceneOption in allSceneOptions:
      let selected = if sceneOption.id == currentSceneId: " selected" else: ""
      sceneOptionsHtml.add(
        fmt"<option value='{h(sceneOption.id.string)}'{selected}>{h(sceneOption.name)}</option>"
      )

    fieldsHtml.add("<input type='submit' id='setSceneState' value='Set Scene State'>")
    {.gcsafe.}:
      let controlHtml = webAssets.getAsset("assets/compiled/web/control.html").
        replace("/*$$fieldsHtml$$*/", fieldsHtml).
        replace("/*$$fieldsSubmitHtml$$*/", fieldsSubmitHtml).
        replace("/*$$sceneOptionsHtml$$*/", sceneOptionsHtml).
        replace("Frame Control", if globalFrameConfig.name != "": h(globalFrameConfig.name) else: "Frame Control")
      request.respond(Http200, body = controlHtml)
  )

  result.notFoundHandler = proc(request: Request) =
    log(%*{"event": "404", "path": request.path})
    request.respond(Http404, body = "Not found!")

proc listenForRenderThread(connectionsState: ConnectionsState) {.thread.} =
  while true:
    if hasConnections(connectionsState):
      let (dataAvailable, _) = serverChannel.tryRecv()
      if dataAvailable:
        sendToAll(connectionsState, "render")
        log(%*{"event": "websocket:send", "message": "render"})
      sleep(10)
    else:
      sleep(100)

var renderThread: Thread[ConnectionsState]

proc newServer*(frameOS: FrameOS): types.Server =
  globalFrameOS = frameOS
  globalFrameConfig = frameOS.frameConfig
  globalRunner = frameOS.runner

  let connectionsState = initConnectionsState()
  let router = buildRouter(connectionsState)
  let mummyServer = mummy.newServer(router.toHandler(), makeWebsocketHandler(connectionsState))

  result = types.Server(
    frameConfig: frameOS.frameConfig,
    runner: frameOS.runner,
    mummy: mummyServer,
    connectionsState: connectionsState,
  )

proc startServer*(self: types.Server) =
  log(%*{"event": "http:start", "message": "Starting web server"})
  # mummy.serve blocks this thread, so run render notifications in a background thread.
  createThread(renderThread, listenForRenderThread, self.connectionsState)

  let port = (if self.frameConfig.framePort == 0: 8787 else: self.frameConfig.framePort).Port
  let bindAddr = if self.frameConfig.httpsProxy.enable and self.frameConfig.httpsProxy.exposeOnlyPort: "127.0.0.1" else: "0.0.0.0"
  self.mummy.serve(port = port, address = bindAddr)

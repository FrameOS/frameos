import json
import pixie
import chroma
import times
import assets/web as webAssets
import assets/frame_web as frameWebAssets
import asyncdispatch
import httpclient
import httpcore
import os
import threadpool
import jester
import locks
import ws, ws/jester_extra
import strformat
import options
import strutils
import tables
import zippy
import drivers/drivers as drivers
import frameos/apps
import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/font
import frameos/config
import frameos/portal as netportal
from net import Port
from frameos/scenes import getLastImagePng, getLastPublicState, getAllPublicStates, getUploadedScenePayload
from scenes/scenes import sceneOptions

var globalFrameOS: FrameOS
var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl
let indexHtml = webAssets.getAsset("assets/compiled/web/index.html")
let frameWebIndexHtml = frameWebAssets.getAsset("assets/compiled/frame_web/index.html")

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

proc contentTypeForAsset(path: string): string =
  if path.endsWith(".css"):
    "text/css"
  elif path.endsWith(".js"):
    "application/javascript"
  elif path.endsWith(".svg"):
    "image/svg+xml"
  elif path.endsWith(".png"):
    "image/png"
  elif path.endsWith(".woff2"):
    "font/woff2"
  elif path.endsWith(".woff"):
    "font/woff"
  else:
    "application/octet-stream"

proc loadConfigJson(): JsonNode =
  try:
    return parseFile(getConfigFilename())
  except CatchableError:
    return %*{}

proc loadScenePayload(): JsonNode =
  var data = ""
  let envPath = getEnv("FRAMEOS_SCENES_JSON")
  if envPath.len > 0:
    try:
      if envPath.endsWith(".gz") and fileExists(envPath):
        data = uncompress(readFile(envPath))
      elif fileExists(envPath):
        data = readFile(envPath)
    except CatchableError:
      data = ""
  if data.len == 0:
    try:
      if fileExists("./scenes.json.gz"):
        data = uncompress(readFile("./scenes.json.gz"))
      elif fileExists("./scenes.json"):
        data = readFile("./scenes.json")
    except CatchableError:
      data = ""
  if data.len == 0:
    return %*[]
  try:
    let payload = parseJson(data)
    if payload.kind == JArray:
      return payload
  except JsonParsingError, CatchableError:
    discard
  return %*[]

proc frameControlCodeJson(controlCode: ControlCode): JsonNode =
  if controlCode == nil:
    return %*{}
  result = %*{
    "enabled": controlCode.enabled,
    "position": controlCode.position,
    "size": controlCode.size,
    "padding": controlCode.padding,
    "offsetX": controlCode.offsetX,
    "offsetY": controlCode.offsetY,
    "qrCodeColor": controlCode.qrCodeColor.toHtmlHex(),
    "backgroundColor": controlCode.backgroundColor.toHtmlHex(),
  }

proc frameScheduleJson(schedule: FrameSchedule): JsonNode =
  if schedule == nil:
    return %*{"events": %*[]}
  var events: seq[JsonNode] = @[]
  for event in schedule.events:
    events.add(%*{
      "id": event.id,
      "minute": event.minute,
      "hour": event.hour,
      "weekday": event.weekday,
      "event": event.event,
      "payload": event.payload,
    })
  result = %*{"events": events}

proc frameGpioButtonsJson(buttons: seq[GPIOButton]): JsonNode =
  var entries: seq[JsonNode] = @[]
  for button in buttons:
    entries.add(%*{"pin": button.pin, "label": button.label})
  result = %*entries

proc frameNetworkJson(network: NetworkConfig): JsonNode =
  if network == nil:
    return %*{}
  result = %*{
    "networkCheck": network.networkCheck,
    "networkCheckTimeoutSeconds": network.networkCheckTimeoutSeconds,
    "networkCheckUrl": network.networkCheckUrl,
    "wifiHotspot": network.wifiHotspot,
    "wifiHotspotSsid": network.wifiHotspotSsid,
    "wifiHotspotPassword": network.wifiHotspotPassword,
    "wifiHotspotTimeoutSeconds": network.wifiHotspotTimeoutSeconds,
  }

proc frameAgentJson(agent: AgentConfig): JsonNode =
  if agent == nil:
    return %*{}
  result = %*{
    "agentEnabled": agent.agentEnabled,
    "agentRunCommands": agent.agentRunCommands,
    "agentSharedSecret": agent.agentSharedSecret,
  }

proc framePaletteJson(palette: PaletteConfig): JsonNode =
  if palette == nil:
    return %*{}
  var colors: seq[JsonNode] = @[]
  for color in palette.colors:
    colors.add(%*[color[0], color[1], color[2]])
  result = %*{"colors": colors}

proc frameDeviceConfigJson(deviceConfig: DeviceConfig): JsonNode =
  if deviceConfig == nil:
    return %*{}
  var headers: seq[JsonNode] = @[]
  for header in deviceConfig.httpUploadHeaders:
    headers.add(%*{"name": header.name, "value": header.value})
  result = %*{
    "vcom": deviceConfig.vcom,
    "uploadUrl": deviceConfig.httpUploadUrl,
    "uploadHeaders": headers,
  }

proc frameApiId(): int =
  1

proc parseFrameApiId(rawId: string): int =
  try:
    return parseInt(rawId)
  except CatchableError:
    return -1

proc frameApiPayload(): JsonNode =
  let configJson = loadConfigJson()
  let interval = if configJson.kind == JObject: configJson{"interval"}.getFloat(300) else: 300
  let backgroundColor =
    if configJson.kind == JObject: configJson{"backgroundColor"}.getStr("#000000") else: "#000000"
  let colorValue =
    if configJson.kind == JObject and configJson.hasKey("color"): configJson["color"] else: newJNull()
  let scenesPayload = loadScenePayload()
  var activeConnections = 0
  withLock connectionsLock:
    activeConnections = connections.len

  result = %*{
    "id": frameApiId(),
    "name": globalFrameConfig.name,
    "mode": globalFrameConfig.mode,
    "frame_host": globalFrameConfig.frameHost,
    "frame_port": globalFrameConfig.framePort,
    "frame_access_key": globalFrameConfig.frameAccessKey,
    "frame_access": globalFrameConfig.frameAccess,
    "ssh_user": "",
    "ssh_pass": "",
    "ssh_port": 22,
    "ssh_keys": %*[],
    "server_host": globalFrameConfig.serverHost,
    "server_port": globalFrameConfig.serverPort,
    "server_api_key": globalFrameConfig.serverApiKey,
    "status": "ready",
    "width": globalFrameConfig.width,
    "height": globalFrameConfig.height,
    "device": globalFrameConfig.device,
    "device_config": frameDeviceConfigJson(globalFrameConfig.deviceConfig),
    "color": colorValue,
    "interval": interval,
    "metrics_interval": globalFrameConfig.metricsInterval,
    "scaling_mode": globalFrameConfig.scalingMode,
    "rotate": globalFrameConfig.rotate,
    "flip": globalFrameConfig.flip,
    "background_color": backgroundColor,
    "scenes": scenesPayload,
    "debug": globalFrameConfig.debug,
    "log_to_file": globalFrameConfig.logToFile,
    "assets_path": globalFrameConfig.assetsPath,
    "save_assets": globalFrameConfig.saveAssets,
    "control_code": frameControlCodeJson(globalFrameConfig.controlCode),
    "schedule": frameScheduleJson(globalFrameConfig.schedule),
    "gpio_buttons": frameGpioButtonsJson(globalFrameConfig.gpioButtons),
    "network": frameNetworkJson(globalFrameConfig.network),
    "agent": frameAgentJson(globalFrameConfig.agent),
    "palette": framePaletteJson(globalFrameConfig.palette),
    "active_connections": activeConnections,
  }

proc shouldReturnNotModified*(headers: HttpHeaders, lastUpdate: float): bool {.gcsafe.} =
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

proc buildFrameImageResponse(request: Request): tuple[status: HttpCode, headers: seq[(string, string)], body: string] =
  let (sceneId, _, _, lastUpdate) = getLastPublicState()
  if shouldReturnNotModified(request.headers, lastUpdate):
    return (
      Http304,
      @[("X-Scene-Id", $sceneId), ("Access-Control-Expose-Headers", "X-Scene-Id")],
      ""
    )
  var headers = @[
    ("Content-Type", "image/png"),
    ("Content-Disposition", &"inline; filename=\"{sceneId}.png\""),
    ("X-Scene-Id", $sceneId),
    ("Access-Control-Expose-Headers", "X-Scene-Id")
  ]
  if lastUpdate > 0.0:
    let lastModified = format(fromUnix(int64(lastUpdate)), "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    headers.add(("Last-Modified", lastModified))
  try:
    let image = drivers.toPng(360 - globalFrameConfig.rotate)
    if image != "":
      return (Http200, headers, image)
    else:
      raise newException(Exception, "No image available")
  except Exception:
    try:
      return (Http200, headers, getLastImagePng())
    except Exception as e:
      let payload = renderError(globalFrameConfig.renderWidth(), globalFrameConfig.renderHeight(),
        &"Error: {$e.msg}\n{$e.getStackTrace()}").encodeImage(PngFormat)
      return (Http200, headers, payload)


const AUTH_HEADER = "authorization"
const AUTH_TYPE = "Bearer"
const ACCESS_COOKIE = "frame_access_key"

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
        if contains(paramsTable, "k") and paramsTable["k"] == accessKey:
          return true
        let cookieHeader = request.headers.getOrDefault("cookie")
        for cookie in cookieHeader.split(";"):
          let parts = cookie.strip().split("=", 1)
          if parts.len == 2 and parts[0] == ACCESS_COOKIE and parts[1] == accessKey:
            return true
        return false
  get "/":
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.pathInfo})
        resp Http200, netportal.setupHtml(globalFrameOS)
      else:
        let accessKey = globalFrameConfig.frameAccessKey
        let paramsTable = request.params()
        if accessKey != "" and contains(paramsTable, "k") and paramsTable["k"] == accessKey:
          resp Http302, {"Location": "/",
            "Set-Cookie": ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"}, ""
        elif not hasAccess(request, Read):
          resp Http401, "Unauthorized"
        else:
          let scalingMode = case globalFrameConfig.scalingMode:
            of "cover", "center": globalFrameConfig.scalingMode
            of "stretch": "100% 100%"
            else: "contain"
          resp Http200, frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode)
  get "/control":
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.pathInfo})
        resp Http200, netportal.setupHtml(globalFrameOS)
      else:
        let accessKey = globalFrameConfig.frameAccessKey
        let paramsTable = request.params()
        if accessKey != "" and contains(paramsTable, "k") and paramsTable["k"] == accessKey:
          resp Http302, {"Location": "/control",
            "Set-Cookie": ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"}, ""
        else:
          let scalingMode = case globalFrameConfig.scalingMode:
            of "cover", "center": globalFrameConfig.scalingMode
            of "stretch": "100% 100%"
            else: "contain"
          resp Http200, frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode)
  get "/new":
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.pathInfo})
        resp Http200, netportal.setupHtml(globalFrameOS)
      else:
        let accessKey = globalFrameConfig.frameAccessKey
        let paramsTable = request.params()
        if accessKey != "" and contains(paramsTable, "k") and paramsTable["k"] == accessKey:
          resp Http302, {"Location": "/new",
            "Set-Cookie": ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"}, ""
        else:
          let scalingMode = case globalFrameConfig.scalingMode:
            of "cover", "center": globalFrameConfig.scalingMode
            of "stretch": "100% 100%"
            else: "contain"
          resp Http200, frameWebIndexHtml.replace("/*$scalingMode*/contain", scalingMode)
  get "/new/static/@asset":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let assetPath = "assets/compiled/frame_web/static/" & @"asset"
      try:
        let asset = frameWebAssets.getAsset(assetPath)
        resp Http200, {"Content-Type": contentTypeForAsset(assetPath)}, asset
      except KeyError:
        resp Http404, "Not found!"
  get "/static/@asset":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let assetPath = "assets/compiled/frame_web/static/" & @"asset"
      try:
        let asset = frameWebAssets.getAsset(assetPath)
        resp Http200, {"Content-Type": contentTypeForAsset(assetPath)}, asset
      except KeyError:
        resp Http404, "Not found!"
  post "/setup":
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        resp Http400, "Not in setup mode"
      let params = request.params()
      log(%*{"event": "portal:http", "post": request.pathInfo, "params": params})
      spawn netportal.connectToWifi(
        globalFrameOS,
        params["ssid"],
        params.getOrDefault("password", ""),
        params.getOrDefault("serverHost", globalFrameOS.frameConfig.serverHost),
        params.getOrDefault("serverPort", $globalFrameOS.frameConfig.serverPort),
      )
    resp Http200, netportal.confirmHtml()
  get "/ping":
    resp Http200, "pong"
  get "/setup":
    redirect "/"
  get "/wifi":
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        resp Http400, "Not in setup mode"
      else:
        let nets = netportal.availableNetworks(globalFrameOS)
        resp Http200, {"Content-Type": "application/json"}, $(%*{"networks": nets})
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
      let (status, headers, body) = buildFrameImageResponse(request)
      resp status, headers, body
  get "/api/frames":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let framePayload = frameApiPayload()
      resp Http200, {"Content-Type": "application/json"}, $(%*{"frames": @[framePayload]})
  get "/api/frames/@id":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let framePayload = frameApiPayload()
        resp Http200, {"Content-Type": "application/json"}, $(%*{"frame": framePayload})
  get "/api/frames/@id/state":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let (sceneId, state, _, _) = getLastPublicState()
        resp Http200, {"Content-Type": "application/json"}, $(%*{"sceneId": $sceneId, "state": state})
  get "/api/frames/@id/states":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let (sceneId, states) = getAllPublicStates()
        resp Http200, {"Content-Type": "application/json"}, $(%*{"sceneId": $sceneId, "states": states})
  get "/api/frames/@id/uploaded_scenes":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let payload = %*{"scenes": getUploadedScenePayload()}
        resp Http200, {"Content-Type": "application/json"}, $payload
  get "/api/frames/@id/logs":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        resp Http200, {"Content-Type": "application/json"}, $(%*{"logs": %*[]})
  get "/api/frames/@id/metrics":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        resp Http200, {"Content-Type": "application/json"}, $(%*{"metrics": %*[]})
  get "/api/frames/@id/assets":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        resp Http200, {"Content-Type": "application/json"}, $(%*{"assets": %*[]})
  get "/api/frames/@id/image_token":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let token = if globalFrameConfig.frameAccessKey.len > 0: globalFrameConfig.frameAccessKey else: "frame"
        resp Http200, {"Content-Type": "application/json"}, $(%*{"token": token, "expires_in": 3600})
  get "/api/frames/@id/image":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let (status, headers, body) = buildFrameImageResponse(request)
        resp status, headers, body
  get "/api/frames/@id/scene_images/@sceneId":
    if not hasAccess(request, Read):
      resp Http401, "Unauthorized"
    {.gcsafe.}:
      let requestedId = parseFrameApiId(@"id")
      if requestedId != frameApiId():
        resp Http404, "Not found!"
      else:
        let (status, headers, body) = buildFrameImageResponse(request)
        resp status, headers, body
  post "/event/@name":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "post": request.pathInfo})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(@"name", payload)
    resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
  post "/uploadScenes":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "post": request.pathInfo})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
  post "/reload":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    try:
      {.gcsafe.}: # TODO: implement an actual lock
        let newConfig = loadConfig()
        updateFrameConfigFrom(globalFrameOS.frameConfig, newConfig)
      sendEvent("reload", %*{})
      resp Http200, {"Content-Type": "application/json"}, $(%*{"status": "ok"})
    except CatchableError as e:
      log(%*{"event": "reload:error", "error": e.msg})
      resp Http500, {"Content-Type": "application/json"}, $(%*{"status": "error", "error": e.msg})
  get "/states":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "get": request.pathInfo})
    {.gcsafe.}: # It's a copy of the state, so it's fine.
      let (sceneId, states) = getAllPublicStates()
      resp Http200, {"Content-Type": "application/json"}, $(%*{"sceneId": $sceneId, "states": states})
  get "/getUploadedScenes":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "get": request.pathInfo})
    {.gcsafe.}:
      var payload = %*{"scenes": getUploadedScenePayload()}
      resp Http200, {"Content-Type": "application/json"}, $payload
  get "/state":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
    log(%*{"event": "http", "get": request.pathInfo})
    {.gcsafe.}: # It's a copy of the state, so it's fine.
      let (sceneId, state, _, _) = getLastPublicState()
      resp Http200, {"Content-Type": "application/json"}, $(%*{"sceneId": $sceneId, "state": state})
  get "/c":
    if not hasAccess(request, Write):
      resp Http401, "Unauthorized"
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
  globalFrameOS = frameOS
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
